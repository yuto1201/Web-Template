import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  connectorIdentityFor,
  digestValue,
  prepareReviewArtifacts,
  readExternalOperationRequest,
  recordReviewResult,
  renderPullRequestBody,
  resolveInside,
  runAuthoritativePremergeGate,
  runPremergeGate,
  schemas,
  simulateWorkflowFixture,
  snapshotIssueContract,
} from "../tools/workflow-core.mjs";

const fixturePath = path.resolve("tests/fixtures/workflow/happy-path.json");

/** @typedef {import("zod").infer<typeof schemas.modelIdentitySchema>} ModelIdentity */
/** @typedef {import("zod").infer<typeof schemas.riskSchema>} Risk */
/** @typedef {import("zod").infer<typeof schemas.issueContractSchema>} IssueContract */
/** @typedef {import("zod").infer<typeof schemas.verificationSchema>} Verification */
/** @typedef {import("zod").infer<typeof schemas.reviewPacketSchema>} ReviewPacket */
/** @typedef {import("zod").infer<typeof schemas.reviewResultSchema>} ReviewResult */
/**
 * @typedef GateBundle
 * @property {string} currentHeadSha
 * @property {IssueContract} contract
 * @property {Verification} verification
 * @property {ReviewPacket} packet
 * @property {ReviewResult[]} reviews
 * @property {string} root
 */

/**
 * @param {string} configured
 * @param {string} observed
 * @param {ModelIdentity["family"]} family
 * @param {boolean} [fallback]
 * @returns {ModelIdentity}
 */
const model = (configured, observed, family, fallback = false) => ({
  configured,
  observed,
  family,
  fallback,
  parameters: [],
});

/** @param {string} filePath @returns {Promise<unknown>} */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

/** @param {unknown} value @returns {value is { inputs: object }} */
function hasObjectInputs(value) {
  if (!value || typeof value !== "object" || !("inputs" in value)) return false;
  return Boolean(value.inputs) && typeof value.inputs === "object" && !Array.isArray(value.inputs);
}

describe("current-Head pre-merge gate", () => {
  /** @type {string} */
  let root;
  /** @type {GateBundle} */
  let bundle;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "web-template-gate-"));
    const fixture = await readJson(fixturePath);
    const result = await simulateWorkflowFixture(fixture, root);
    bundle = {
      currentHeadSha: result.headSha,
      contract: schemas.issueContractSchema.parse(await readJson(path.join(root, result.paths.contract))),
      verification: schemas.verificationSchema.parse(await readJson(path.join(root, result.paths.verification))),
      packet: schemas.reviewPacketSchema.parse(await readJson(path.join(root, result.paths.packet))),
      reviews: await Promise.all(result.paths.reviews.map(async (reviewPath) => (
        schemas.reviewResultSchema.parse(await readJson(path.join(root, reviewPath)))
      ))),
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

  it("binds every review result to the exact verification and diff bytes", async () => {
    for (const review of bundle.reviews) {
      expect(review.verifyDigest).toBe(bundle.packet.verifyDigest);
      expect(review.diffDigest).toBe(bundle.packet.diffDigest);
    }

    const alteredVerificationReviews = bundle.reviews.map((review) => ({
      ...review,
      verifyDigest: `sha256:${"8".repeat(64)}`,
    }));
    expect(() => runPremergeGate({ ...bundle, reviews: alteredVerificationReviews }))
      .toThrow(/verification digest does not match the packet/u);
    expect(() => renderPullRequestBody({ ...bundle, reviews: alteredVerificationReviews }))
      .toThrow(/verification digest does not match the packet/u);
    await expect(recordReviewResult(root, 42, alteredVerificationReviews[0]))
      .rejects.toThrow(/verification digest does not match the packet/u);

    const alteredDiffReviews = bundle.reviews.map((review) => ({
      ...review,
      diffDigest: `sha256:${"7".repeat(64)}`,
    }));
    expect(() => runPremergeGate({ ...bundle, reviews: alteredDiffReviews }))
      .toThrow(/diff digest does not match the packet/u);
  });

  it("authoritatively gates every configured high-risk operation without calling providers", async () => {
    const highRiskOperations = [
      {
        operation: "github.merge_pr",
        target: { kind: "github.repository", identifier: "config/ownership.json#github" },
        environment: "production",
        reasonCode: "reviewed-release",
        inputs: { issue: 42, prNumber: 77, headSha: bundle.currentHeadSha, method: "squash" },
      },
      {
        operation: "github.update_ruleset",
        target: { kind: "github.repository", identifier: "config/ownership.json#github" },
        environment: "production",
        reasonCode: "reviewed-release",
        inputs: {
          issue: 42,
          rulesetName: "main exact-Head review",
          targetBranch: "main",
          requiredCheckName: "Exact Head review policy",
          enforcement: "active",
        },
      },
      {
        operation: "supabase.apply_migrations",
        target: { kind: "supabase.project", identifier: "config/ownership.json#supabase.projectRef" },
        environment: "production",
        reasonCode: "acceptance-evidence",
        inputs: { projectRefSource: "config/ownership.json", migrations: ["supabase/migrations/20260822000000_issue_42.sql"] },
      },
      {
        operation: "vercel.deploy_preview",
        target: { kind: "vercel.project", identifier: "config/ownership.json#vercel.projectId" },
        environment: "preview",
        reasonCode: "acceptance-evidence",
        inputs: { projectSource: "config/ownership.json", headSha: bundle.currentHeadSha },
      },
      {
        operation: "vercel.deploy_production",
        target: { kind: "vercel.project", identifier: "config/ownership.json#vercel.projectId" },
        environment: "production",
        reasonCode: "reviewed-release",
        inputs: { projectSource: "config/ownership.json", headSha: bundle.currentHeadSha },
      },
      {
        operation: "cloudflare.upsert_dns",
        target: { kind: "cloudflare.zone", identifier: "config/ownership.json#cloudflare.zoneId" },
        environment: "production",
        reasonCode: "reviewed-release",
        inputs: { zoneSource: "config/ownership.json", recordName: "preview.example.com", recordType: "CNAME", target: "cname.vercel-dns.com", proxied: false },
      },
    ];
    const routineOperations = [
      {
        operation: "github.read_issue",
        target: { kind: "github.repository", identifier: "config/ownership.json#github" },
        environment: "none",
        reasonCode: "issue-contract",
        inputs: { issue: 42 },
      },
      {
        operation: "github.push_branch",
        target: { kind: "github.repository", identifier: "config/ownership.json#github" },
        environment: "none",
        reasonCode: "acceptance-evidence",
        inputs: { branch: "cursor/42-workflow-fixture", headSha: bundle.currentHeadSha },
      },
    ];
    const configuredHighRiskOperations = /** @type {{ highRiskOperations: string[] }} */ (
      JSON.parse(await readFile(path.resolve("config/execution.json"), "utf8"))
    ).highRiskOperations;
    expect(highRiskOperations.map(({ operation }) => operation)).toEqual(configuredHighRiskOperations);
    const changedContract = {
      ...bundle.contract,
      externalOperations: [...highRiskOperations, ...routineOperations].map(({ operation }) => operation),
    };
    changedContract.digest = digestValue(changedContract);
    await writeFile(path.join(root, ".artifacts/issues/42/issue-contract.json"), `${JSON.stringify(changedContract, null, 2)}\n`, "utf8");
    const ownershipPath = path.join(root, "config/ownership.json");
    const ownership = /** @type {{
      supabase: { projectRef: string | null },
      vercel: { projectId: string | null },
      cloudflare: { accountId?: string | null, zoneId: string | null }
    }} */ (
      JSON.parse(await readFile(ownershipPath, "utf8"))
    );
    ownership.supabase.projectRef = "abcdefghijklmnopqrst";
    ownership.vercel.projectId = "prj_cursor_fixture";
    ownership.cloudflare.zoneId = "0".repeat(32);
    ownership.cloudflare.accountId = "00000000000000000000000000000042";
    await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`, "utf8");

    for (const [index, candidate] of highRiskOperations.entries()) {
      const provider = /** @type {"github" | "supabase" | "vercel" | "cloudflare"} */ (candidate.operation.split(".")[0]);
      const owner = provider === "github" ? "yuto1201" : provider === "supabase" ? "fixture" : provider === "vercel" ? "fixture-scope" : "00000000000000000000000000000042";
      const request = {
        schemaVersion: 2,
        requestId: `issue-42-${candidate.operation.replace(/[._]/gu, "-")}-${index + 1}`,
        issue: 42,
        authority: { executionSurface: "codex-local", runId: `local-issue-42-high-${index + 1}`, contractDigest: changedContract.digest, activationEvidenceRef: null, connectorIdentity: connectorIdentityFor(provider, owner) },
        operation: candidate.operation,
        environment: candidate.environment,
        reasonCode: candidate.reasonCode,
        inputs: candidate.inputs,
      };
      const requestPath = `.artifacts/ops-requests/${request.requestId}.json`;
      await mkdir(path.join(root, ".artifacts/ops-requests"), { recursive: true });
      await writeFile(path.join(root, requestPath), `${JSON.stringify(request, null, 2)}\n`, "utf8");
      await expect(readExternalOperationRequest(root, requestPath)).rejects.toThrow(/Pre-merge gate|contract digest|risk/u);
    }
    for (const [index, candidate] of routineOperations.entries()) {
      const request = {
        schemaVersion: 2,
        requestId: `issue-42-${candidate.operation.replace(/[._]/gu, "-")}-${index + 1}`,
        issue: 42,
        authority: { executionSurface: "codex-local", runId: `local-issue-42-routine-${index + 1}`, contractDigest: changedContract.digest, activationEvidenceRef: null, connectorIdentity: connectorIdentityFor("github", "yuto1201") },
        operation: candidate.operation,
        environment: candidate.environment,
        reasonCode: candidate.reasonCode,
        inputs: candidate.inputs,
      };
      const requestPath = `.artifacts/ops-requests/${request.requestId}.json`;
      await writeFile(path.join(root, requestPath), `${JSON.stringify(request, null, 2)}\n`, "utf8");
      await expect(readExternalOperationRequest(root, requestPath)).resolves.toMatchObject({ gate: null });
    }
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
    /** @type {Array<["codex-local" | "claude-local", ModelIdentity, ModelIdentity]>} */
    const cases = [
      ["codex-local", model("gpt-5.6-sol", "gpt-5.6-sol", "openai"), model("claude-opus-5", "claude-opus-5", "anthropic")],
      ["claude-local", model("claude-opus-5", "claude-opus-5", "anthropic"), model("gpt-5.6-sol", "gpt-5.6-sol", "openai")],
    ];
    for (const [executionSurface, primaryModel, reviewerModel] of cases) {
      const contract = {
        ...bundle.contract,
        externalOperations: [],
      };
      contract.digest = digestValue(contract);
      /** @type {Risk} */
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
    const verifyPath = path.join(root, bundle.packet.verifyPath);
    const originalVerificationBytes = await readFile(verifyPath, "utf8");
    await writeFile(verifyPath, `${originalVerificationBytes}\n`, "utf8");
    await expect(runAuthoritativePremergeGate(root, 42)).rejects.toThrow(/verification digest/u);
    await writeFile(verifyPath, originalVerificationBytes, "utf8");

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

  it("binds review preparation and authoritative evidence to the real surface and Issue branch", async () => {
    expect(spawnSync("git", ["branch", "-m", "codex/42-wrong-surface"], { cwd: root, windowsHide: true }).status).toBe(0);
    await expect(runAuthoritativePremergeGate(root, 42)).rejects.toThrow(/surface cursor-cloud/u);
    await expect(prepareReviewArtifacts(root, {
      schemaVersion: 2,
      issue: 42,
      executionSurface: "cursor-cloud",
      primaryModel: model("composer-2.5", "composer-2.5", "cursor"),
      status: "passed",
      commands: [{ command: "npm test", status: "passed", summary: "Passed." }],
      acceptanceEvidence: [{ id: "AC-1", status: "supported", evidence: ["test"] }],
      externalChanges: [],
      remainingWork: [],
      completedAt: "2026-08-21T01:10:00+09:00",
    })).rejects.toThrow(/surface cursor-cloud/u);

    expect(spawnSync("git", ["branch", "-m", "codex/41-wrong-issue"], { cwd: root, windowsHide: true }).status).toBe(0);
    await expect(prepareReviewArtifacts(root, {
      schemaVersion: 2,
      issue: 42,
      executionSurface: "codex-local",
      primaryModel: model("gpt-5.6-sol", "gpt-5.6-sol", "openai"),
      status: "passed",
      commands: [{ command: "npm test", status: "passed", summary: "Passed." }],
      acceptanceEvidence: [{ id: "AC-1", status: "supported", evidence: ["test"] }],
      externalChanges: [],
      remainingWork: [],
      completedAt: "2026-08-21T01:10:00+09:00",
    })).rejects.toThrow(/issue 42/u);
  });

  it("re-derives the base SHA from the configured base ref", async () => {
    const packetPath = path.join(root, `.artifacts/issues/42/${bundle.currentHeadSha}/review-packet.json`);
    await writeFile(packetPath, `${JSON.stringify({ ...bundle.packet, baseSha: bundle.currentHeadSha }, null, 2)}\n`, "utf8");
    await expect(runAuthoritativePremergeGate(root, 42)).rejects.toThrow(/authoritative base ref/u);
  });

  it("rejects a gated external merge request with a different Head", async () => {
    const requestPath = path.join(root, `.artifacts/ops-requests/issue-42-github-merge-pr-1.json`);
    const request = await readJson(requestPath);
    if (!hasObjectInputs(request)) throw new Error("Workflow fixture merge request is invalid.");
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
