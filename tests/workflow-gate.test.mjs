import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadProtectedAuthority,
  loadProtectedExecutionPolicy,
  prepareReviewArtifacts,
  readExternalOperationRequest,
  requiresAuthoritativeHead,
  resolveInside,
  runAuthoritativePremergeGate,
  runPremergeGate,
  simulateWorkflowFixture,
  snapshotIssueContract,
} from "../tools/workflow-core.mjs";

const fixturePath = path.resolve("tests/fixtures/workflow/happy-path.json");

/** @param {string} filePath */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

describe("current-Head pre-merge gate", () => {
  it("centrally classifies repository-derived high-risk operations", () => {
    for (const operation of [
      "github.merge_pr",
      "supabase.apply_migrations",
      "vercel.deploy_preview",
      "vercel.deploy_production",
      "cloudflare.upsert_dns",
    ]) {
      expect(requiresAuthoritativeHead(operation), operation).toBe(true);
    }
    expect(requiresAuthoritativeHead("github.read_issue")).toBe(false);
    expect(() => requiresAuthoritativeHead("github.update_ruleset")).toThrow(/unsupported|invalid/iu);
  });

  /** @type {string} */
  let root;
  /** @type {any} */
  let bundle;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "web-template-gate-"));
    const fixture = await readJson(fixturePath);
    const result = await simulateWorkflowFixture(fixture, root);
    const reviews = await Promise.all(result.paths.reviews.map((reviewPath) => readJson(path.join(root, reviewPath))));
    bundle = {
      currentHeadSha: result.headSha,
      contract: await readJson(path.join(root, result.paths.contract)),
      verification: await readJson(path.join(root, result.paths.verification)),
      packet: await readJson(path.join(root, result.paths.packet)),
      reviews,
      root,
    };
  });

  it("approves evidence bound to exactly the current Head and Issue contract", () => {
    expect(runPremergeGate(bundle)).toMatchObject({
      ok: true,
      issue: 42,
      headSha: bundle.currentHeadSha,
      risk: { level: "high" },
      reviewers: [{ family: "anthropic" }, { family: "openai" }],
    });
  });

  it("approves exact-Head low-risk evidence without review artifacts and still requires reviews above low", async () => {
    const lowRoot = await mkdtemp(path.join(os.tmpdir(), "web-template-low-gate-"));
    /** @param {string[]} args */
    const git = (...args) => spawnSync("git", args, { cwd: lowRoot, encoding: "utf8", windowsHide: true });
    expect(git("init", "--initial-branch=main").status).toBe(0);
    expect(git("config", "user.name", "Low Risk Fixture").status).toBe(0);
    expect(git("config", "user.email", "low-risk@example.invalid").status).toBe(0);
    await mkdir(path.join(lowRoot, "config"), { recursive: true });
    await writeFile(path.join(lowRoot, ".gitignore"), ".artifacts/\n", "utf8");
    await writeFile(path.join(lowRoot, "README.md"), "# Base\n", "utf8");
    await writeFile(path.join(lowRoot, "config", "ownership.json"), await readFile(path.resolve("config/ownership.json"), "utf8"), "utf8");
    await writeFile(path.join(lowRoot, "config", "execution.json"), await readFile(path.resolve("config/execution.json"), "utf8"), "utf8");
    expect(git("add", ".").status).toBe(0);
    expect(git("commit", "-m", "base").status).toBe(0);
    expect(git("switch", "-c", "codex/42-low-risk").status).toBe(0);
    await writeFile(path.join(lowRoot, "README.md"), "# Base\n\nClarified wording.\n", "utf8");
    expect(git("commit", "-am", "docs update").status).toBe(0);
    const contract = snapshotIssueContract({
      schemaVersion: 2,
      issue: 42,
      repository: "yuto1201/Web-Template",
      goal: "Clarify non-operational documentation.",
      acceptanceCriteria: [{ id: "AC-1", text: "Documentation remains valid." }],
      dependencies: [],
      externalAuthorizations: [],
    }, "2026-08-30T01:00:00+09:00", loadProtectedAuthority(lowRoot, "main"));
    await mkdir(path.join(lowRoot, ".artifacts", "issues", "42"), { recursive: true });
    await writeFile(path.join(lowRoot, ".artifacts", "issues", "42", "issue-contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    const prepared = await prepareReviewArtifacts(lowRoot, {
      schemaVersion: 2,
      issue: 42,
      executionSurface: "codex-local",
      primaryOperatorLabel: "codex",
      primaryModel: {
        configured: "gpt-5.6-sol[effort=high]",
        observed: "gpt-5.6-sol",
        family: "openai",
        fallback: false,
        parameters: [{ id: "effort", value: "high" }],
      },
      status: "passed",
      commands: [{ command: "npm run check:docs", status: "passed", summary: "Documentation checks passed." }],
      acceptanceEvidence: [{ id: "AC-1", status: "supported", evidence: ["README.md"] }],
      externalChanges: [],
      remainingWork: [],
      completedAt: "2026-08-30T01:10:00+09:00",
    });
    expect(runPremergeGate({
      currentHeadSha: prepared.packet.headSha,
      contract,
      verification: prepared.verification,
      packet: prepared.packet,
      reviews: [],
      root: lowRoot,
    })).toMatchObject({ risk: { level: "low" }, reviewers: [] });
    expect(() => runPremergeGate({ ...bundle, reviews: [] })).toThrow(/reviewer|family|review evidence/iu);
  });

  it("uses protected-main policy when the candidate attempts to lower its own source risk", async () => {
    const policyRoot = await mkdtemp(path.join(os.tmpdir(), "web-template-protected-policy-"));
    /** @param {string[]} args */
    const git = (...args) => spawnSync("git", args, { cwd: policyRoot, encoding: "utf8", windowsHide: true });
    expect(git("init", "--initial-branch=main").status).toBe(0);
    expect(git("config", "user.name", "Protected Policy Fixture").status).toBe(0);
    expect(git("config", "user.email", "protected-policy@example.invalid").status).toBe(0);
    await mkdir(path.join(policyRoot, "config"), { recursive: true });
    await mkdir(path.join(policyRoot, "src", "app"), { recursive: true });
    await writeFile(path.join(policyRoot, ".gitignore"), ".artifacts/\n", "utf8");
    await writeFile(path.join(policyRoot, "config", "ownership.json"), await readFile(path.resolve("config/ownership.json"), "utf8"), "utf8");
    const protectedPolicy = await readJson(path.resolve("config/execution.json"));
    await writeFile(path.join(policyRoot, "config", "execution.json"), `${JSON.stringify(protectedPolicy, null, 2)}\n`, "utf8");
    await writeFile(path.join(policyRoot, "src", "app", "page.tsx"), "export default function Page() { return null; }\n", "utf8");
    expect(git("add", ".").status).toBe(0);
    expect(git("commit", "-m", "base").status).toBe(0);
    expect(git("switch", "-c", "codex/42-policy-downgrade").status).toBe(0);
    protectedPolicy.lowRiskPathRules.push({ type: "exact", path: "src/app/page.tsx" });
    await writeFile(path.join(policyRoot, "config", "execution.json"), `${JSON.stringify(protectedPolicy, null, 2)}\n`, "utf8");
    await writeFile(path.join(policyRoot, "src", "app", "page.tsx"), "export default function Page() { return <main>Changed</main>; }\n", "utf8");
    expect(git("add", ".").status).toBe(0);
    expect(git("commit", "-m", "attempt policy downgrade").status).toBe(0);
    expect(loadProtectedExecutionPolicy(policyRoot, "main").lowRiskPathRules)
      .not.toContainEqual({ type: "exact", path: "src/app/page.tsx" });
    const contract = snapshotIssueContract({
      schemaVersion: 2,
      issue: 42,
      repository: "yuto1201/Web-Template",
      goal: "Reject candidate-controlled risk reduction.",
      acceptanceCriteria: [{ id: "AC-1", text: "Protected policy controls classification." }],
      dependencies: [],
      externalAuthorizations: [],
    }, "2026-08-30T02:00:00+09:00", loadProtectedAuthority(policyRoot, "main"));
    await mkdir(path.join(policyRoot, ".artifacts", "issues", "42"), { recursive: true });
    await writeFile(path.join(policyRoot, ".artifacts", "issues", "42", "issue-contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    const prepared = await prepareReviewArtifacts(policyRoot, {
      schemaVersion: 2,
      issue: 42,
      executionSurface: "codex-local",
      primaryOperatorLabel: "codex",
      primaryModel: {
        configured: "gpt-5.6-sol[effort=high]",
        observed: "gpt-5.6-sol",
        family: "openai",
        fallback: false,
        parameters: [{ id: "effort", value: "high" }],
      },
      status: "passed",
      commands: [{ command: "npm run check", status: "passed", summary: "Checks passed." }],
      acceptanceEvidence: [{ id: "AC-1", status: "supported", evidence: ["protected policy test"] }],
      externalChanges: [],
      remainingWork: [],
      completedAt: "2026-08-30T02:10:00+09:00",
    });
    expect(prepared.packet.risk).toEqual({ level: "high", reasons: ["path:config/"] });
    expect(prepared.packet.requiredReviewerFamilies).toEqual(["anthropic", "openai"]);
  });

  it("fails closed when verification or review is stale", () => {
    expect(() => runPremergeGate({ ...bundle, currentHeadSha: "9".repeat(40) })).toThrow(/Verification evidence is stale/u);
    const staleReview = { ...bundle.reviews[0], headSha: "9".repeat(40), verifySha: "9".repeat(40) };
    expect(() => runPremergeGate({ ...bundle, reviews: [staleReview, bundle.reviews[1]] })).toThrow(/does not match the packet/u);
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

    const unsupportedReview = {
      ...bundle.reviews[0],
      acceptanceAssessment: [{ ...bundle.reviews[0].acceptanceAssessment[0], status: "unsupported" }],
    };
    expect(() => runPremergeGate({ ...bundle, reviews: [unsupportedReview, bundle.reviews[1]] })).toThrow(/marks AC-1 unsupported/u);
  });

  it("rejects free-form or missing external-operation lifecycle evidence", () => {
    expect(() => runPremergeGate({
      ...bundle,
      verification: { ...bundle.verification, externalChanges: ["deployed manually"] },
    })).toThrow(/external change|object|lifecycle/iu);
    expect(() => runPremergeGate({
      ...bundle,
      packet: {
        ...bundle.packet,
        changedPaths: [...bundle.packet.changedPaths, "evidence/external-operations/merge/result.json"],
      },
    })).toThrow(/external change|lifecycle|committed artifact/iu);
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
      .rejects.toThrow(/authoritative review gate|frozen constraint headSha/u);
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
    await writeFile(
      path.join(renameRoot, "config", "ownership.json"),
      await readFile(path.resolve("config/ownership.json"), "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(renameRoot, "config", "execution.json"),
      await readFile(path.resolve("config/execution.json"), "utf8"),
      "utf8",
    );
    await writeFile(path.join(renameRoot, "src", "lib", "auth", "session.ts"), "export const session = true;\n", "utf8");
    expect(git("add", ".").status).toBe(0);
    expect(git("commit", "-m", "base auth file").status).toBe(0);
    expect(git("switch", "-c", "codex/42-rename").status).toBe(0);
    expect(git("mv", "src/lib/auth/session.ts", "src/lib/session.ts").status).toBe(0);
    expect(git("commit", "-m", "move auth file").status).toBe(0);
    const contract = snapshotIssueContract({
      schemaVersion: 2,
      issue: 42,
      repository: "yuto1201/Web-Template",
      goal: "Review both sides of a privileged rename.",
      acceptanceCriteria: [{ id: "AC-1", text: "Rename is reviewed." }],
      dependencies: [],
      externalAuthorizations: [],
    }, "2026-08-21T01:00:00+09:00", loadProtectedAuthority(renameRoot, "main"));
    await mkdir(path.join(renameRoot, ".artifacts", "issues", "42"), { recursive: true });
    await writeFile(path.join(renameRoot, ".artifacts", "issues", "42", "issue-contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    const prepared = await prepareReviewArtifacts(renameRoot, {
      schemaVersion: 2,
      issue: 42,
      executionSurface: "codex-local",
      primaryOperatorLabel: "codex",
      primaryModel: {
        configured: "gpt-5.6-sol[effort=high]",
        observed: "gpt-5.6-sol",
        family: "openai",
        fallback: false,
        parameters: [{ id: "effort", value: "high" }],
      },
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
