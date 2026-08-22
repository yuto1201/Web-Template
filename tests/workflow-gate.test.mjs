import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  digestValue,
  prepareReviewArtifacts,
  readExternalOperationRequest,
  recordReviewResult,
  resolveInside,
  runAuthoritativePremergeGate,
  runPremergeGate,
  simulateWorkflowFixture,
  snapshotIssueContract,
} from "../tools/workflow-core.mjs";

const fixturePath = path.resolve("tests/fixtures/workflow/happy-path.json");
const model = (configured, observed, family, fallback = false) => ({
  configured,
  observed,
  family,
  fallback,
  parameters: [],
});

/** @param {string} filePath */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

describe("current-Head pre-merge gate", () => {
  /** @type {string} */
  let root;
  /** @type {any} */
  let bundle;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "web-template-gate-"));
    const fixture = await readJson(fixturePath);
    const result = await simulateWorkflowFixture(fixture, root);
    bundle = {
      currentHeadSha: result.headSha,
      contract: await readJson(path.join(root, result.paths.contract)),
      verification: await readJson(path.join(root, result.paths.verification)),
      packet: await readJson(path.join(root, result.paths.packet)),
      reviews: await Promise.all(result.paths.reviews.map((reviewPath) => readJson(path.join(root, reviewPath)))),
      root,
    };
  });

  it("approves evidence bound to exactly the current Head and Issue contract", () => {
    expect(runPremergeGate(bundle)).toMatchObject({
      ok: true,
      issue: 42,
      headSha: bundle.currentHeadSha,
      risk: { level: "high" },
      reviewers: [
        { family: "anthropic", reviewedAt: "2026-08-21T01:15:00+09:00" },
        { family: "openai", reviewedAt: "2026-08-21T01:15:00+09:00" },
      ],
    });
  });

  it("requires both Anthropic and OpenAI review families for high-risk evidence", () => {
    expect(() => runPremergeGate({ ...bundle, reviews: [bundle.reviews[0]] })).toThrow(/openai/u);
    expect(() => runPremergeGate({ ...bundle, reviews: [bundle.reviews[0], bundle.reviews[0]] })).toThrow(/unique/u);
    expect(runPremergeGate(bundle).ok).toBe(true);
  });

  it("does not report merge approval after recording only one required high-risk family", async () => {
    await rm(path.join(root, `.artifacts/issues/42/${bundle.currentHeadSha}/reviews/openai.json`));

    const recorded = await recordReviewResult(root, 42, bundle.reviews[0]);

    expect(recorded.nextState).toBe("review-requested");
    await expect(runAuthoritativePremergeGate(root, 42)).rejects.toThrow();
  });

  it("fails closed when verification or review is stale", () => {
    expect(() => runPremergeGate({ ...bundle, currentHeadSha: "9".repeat(40) })).toThrow(/Verification evidence is stale/u);
    const staleReviews = bundle.reviews.map((review) => ({ ...review, headSha: "9".repeat(40), verifySha: "9".repeat(40) }));
    expect(() => runPremergeGate({ ...bundle, reviews: staleReviews })).toThrow(/does not match the packet/u);
  });

  it("requires each acceptance criterion exactly once and supported", () => {
    const duplicateVerification = {
      ...bundle.verification,
      acceptanceEvidence: [
        ...bundle.verification.acceptanceEvidence,
        bundle.verification.acceptanceEvidence[0],
      ],
    };
    expect(() => runPremergeGate({ ...bundle, verification: duplicateVerification })).toThrow(/exactly once/u);

    const unsupportedReviews = bundle.reviews.map((review, index) => index === 0 ? {
      ...review,
      acceptanceAssessment: [{ ...review.acceptanceAssessment[0], status: "unsupported" }],
    } : review);
    expect(() => runPremergeGate({ ...bundle, reviews: unsupportedReviews })).toThrow(/marks AC-1 unsupported/u);
  });

  it("preserves local Codex and Claude review-family decisions in version 2 evidence", () => {
    for (const [executionSurface, primaryModel, reviewerModel] of [
      ["codex-local", model("gpt-5.6-sol", "gpt-5.6-sol", "openai"), model("claude-opus-5", "claude-opus-5", "anthropic")],
      ["claude-local", model("claude-opus-5", "claude-opus-5", "anthropic"), model("gpt-5.6-sol", "gpt-5.6-sol", "openai")],
    ]) {
      const contract = {
        ...bundle.contract,
        externalOperations: [],
      };
      contract.digest = digestValue(contract);
      const risk = { level: "normal", reasons: [] };
      const packet = {
        ...bundle.packet,
        executionSurface,
        primaryModel,
        risk,
        requiredReviewerFamilies: [reviewerModel.family],
        contractDigest: contract.digest,
      };
      const verification = {
        ...bundle.verification,
        executionSurface,
        primaryModel,
        risk,
        requiredReviewerFamilies: [reviewerModel.family],
        contractDigest: contract.digest,
      };
      const reviews = [{
        ...bundle.reviews[0],
        executionSurface,
        primaryModel,
        reviewerModel,
        risk,
        contractDigest: contract.digest,
      }];
      expect(runPremergeGate({ ...bundle, contract, packet, verification, reviews }).reviewers)
        .toEqual([{ family: reviewerModel.family, reviewedAt: reviews[0].reviewedAt }]);
    }
  });

  it("rejects evidence for a silently changed Issue contract", () => {
    const changedContract = { ...bundle.contract, goal: "Changed after review." };
    expect(() => runPremergeGate({ ...bundle, contract: changedContract })).toThrow(/digest mismatch/u);
  });

  it("binds digests and changed paths to the real repository diff", async () => {
    const diffPath = path.join(root, bundle.packet.diffPath);
    await writeFile(diffPath, "tampered diff\n", "utf8");
    await expect(runAuthoritativePremergeGate(root, 42)).rejects.toThrow(/repository diff/u);

    await writeFile(diffPath, spawnSync("git", ["diff", "--no-ext-diff", "--no-renames", "--binary", bundle.packet.baseSha, bundle.currentHeadSha, "--"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).stdout, "utf8");
    const packetPath = path.join(root, `.artifacts/issues/42/${bundle.currentHeadSha}/review-packet.json`);
    const changedPacket = { ...bundle.packet, changedPaths: ["README.md"] };
    await writeFile(packetPath, `${JSON.stringify(changedPacket, null, 2)}\n`, "utf8");
    await expect(runAuthoritativePremergeGate(root, 42)).rejects.toThrow(/changed paths/u);
  });

  it("fails after the real repository Head advances", async () => {
    await writeFile(path.join(root, "later.txt"), "new head\n", "utf8");
    expect(spawnSync("git", ["add", "later.txt"], { cwd: root, windowsHide: true }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "advance head"], { cwd: root, windowsHide: true }).status).toBe(0);
    await expect(runAuthoritativePremergeGate(root, 42)).rejects.toThrow();
  });

  it("re-derives the base SHA from the configured base ref", async () => {
    const packetPath = path.join(root, `.artifacts/issues/42/${bundle.currentHeadSha}/review-packet.json`);
    await writeFile(packetPath, `${JSON.stringify({ ...bundle.packet, baseSha: bundle.currentHeadSha }, null, 2)}\n`, "utf8");
    await expect(runAuthoritativePremergeGate(root, 42)).rejects.toThrow(/authoritative base ref/u);
  });

  it("rejects a gated external merge request with a different Head", async () => {
    const requestPath = path.join(root, `.artifacts/ops-requests/issue-42-github-merge-pr-1.json`);
    const request = await readJson(requestPath);
    await writeFile(requestPath, `${JSON.stringify({ ...request, inputs: { ...request.inputs, headSha: "9".repeat(40) } }, null, 2)}\n`, "utf8");
    await expect(readExternalOperationRequest(root, ".artifacts/ops-requests/issue-42-github-merge-pr-1.json"))
      .rejects.toThrow(/authoritative review gate/u);
  });

  it("includes the privileged source path when Git detects a rename", async () => {
    const renameRoot = await mkdtemp(path.join(os.tmpdir(), "web-template-rename-"));
    /** @param {string[]} args */
    const git = (...args) => spawnSync("git", args, { cwd: renameRoot, encoding: "utf8", windowsHide: true });
    expect(git("init", "--initial-branch=main").status).toBe(0);
    expect(git("config", "user.name", "Rename Fixture").status).toBe(0);
    expect(git("config", "user.email", "rename@example.invalid").status).toBe(0);
    await mkdir(path.join(renameRoot, "config"), { recursive: true });
    await mkdir(path.join(renameRoot, "src", "lib", "auth"), { recursive: true });
    await writeFile(path.join(renameRoot, ".gitignore"), ".artifacts/\n", "utf8");
    await writeFile(path.join(renameRoot, "config", "ownership.json"), JSON.stringify({
      schemaVersion: 1,
      github: { owner: "yuto1201", repository: "Web-Template" },
      supabase: { projectRef: null },
      vercel: { projectId: null },
      cloudflare: { zoneId: null },
    }), "utf8");
    await writeFile(path.join(renameRoot, "src", "lib", "auth", "session.ts"), "export const session = true;\n", "utf8");
    expect(git("add", ".").status).toBe(0);
    expect(git("commit", "-m", "base auth file").status).toBe(0);
    expect(git("switch", "-c", "codex/42-rename").status).toBe(0);
    expect(git("mv", "src/lib/auth/session.ts", "src/lib/session.ts").status).toBe(0);
    expect(git("commit", "-m", "move auth file").status).toBe(0);
    const contract = snapshotIssueContract({
      schemaVersion: 1,
      issue: 42,
      repository: "yuto1201/Web-Template",
      goal: "Review both sides of a privileged rename.",
      acceptanceCriteria: [{ id: "AC-1", text: "Rename is reviewed." }],
      dependencies: [],
      externalOperations: [],
    }, "2026-08-21T01:00:00+09:00");
    await mkdir(path.join(renameRoot, ".artifacts", "issues", "42"), { recursive: true });
    await writeFile(path.join(renameRoot, ".artifacts", "issues", "42", "issue-contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    const prepared = await prepareReviewArtifacts(renameRoot, {
      schemaVersion: 2,
      issue: 42,
      executionSurface: "codex-local",
      primaryModel: model("gpt-5.6-sol", "gpt-5.6-sol", "openai"),
      status: "passed",
      commands: [{ command: "npm test", status: "passed", summary: "Passed." }],
      acceptanceEvidence: [{ id: "AC-1", status: "supported", evidence: ["rename test"] }],
      externalChanges: [],
      remainingWork: [],
      completedAt: "2026-08-21T01:10:00+09:00",
    });
    expect(prepared.packet.changedPaths).toEqual(["src/lib/auth/session.ts", "src/lib/session.ts"]);
    expect(prepared.packet.requiredContracts).toContain("supabase-auditor");
  });

  it("accepts a canonical artifact path when the repository root is a filesystem alias", async () => {
    const container = await mkdtemp(path.join(os.tmpdir(), "repository-path-alias-"));
    const realRoot = path.join(container, "real-root");
    const aliasRoot = path.join(container, "alias-root");
    try {
      const artifact = path.join(realRoot, ".artifacts", "issues", "42", "issue-contract.json");
      await mkdir(path.dirname(artifact), { recursive: true });
      await writeFile(artifact, "{}\n", "utf8");
      await symlink(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");

      expect(resolveInside(aliasRoot, artifact, ".artifacts")).toBe(await realpath(artifact));
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  });
});
