import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { authorityDigest } from "../tools/authority-core.mjs";
import {
  digestValue,
  loadProtectedAuthority,
  readExternalOperationRequest,
  requiredReviewContracts,
  resolveExternalAuthorization,
  snapshotIssueContract,
  stateForReview,
  transitionWorkflowState,
  validateExternalOperationRequest,
  validateIssueContract,
  validateReviewResult,
} from "../tools/workflow-core.mjs";

const headSha = "2".repeat(40);
const contractDigest = `sha256:${"3".repeat(64)}`;
const authority = JSON.parse(await readFile(path.resolve("config/ownership.json"), "utf8"));
const protectedAuthority = {
  commitSha: "1".repeat(40),
  authority,
  digest: authorityDigest(authority),
};

function externalAuthorization(issue = 5) {
  return {
    service: "github",
    operation: "github.merge_pr",
    purposeCode: "reviewed-release",
    purpose: `Merge the exact reviewed pull request for Issue ${issue}.`,
    accountRef: "accounts.github",
    targetRef: "resourceTargets.github",
    environment: "production",
    constraints: { issue, method: "squash" },
    requiresExactHead: true,
  };
}

function contractInput() {
  return {
    schemaVersion: 2,
    issue: 5,
    repository: "yuto1201/Web-Template",
    goal: "Automate the Issue workflow.",
    acceptanceCriteria: [{ id: "AC-1", text: "Gate exact evidence." }],
    dependencies: [4],
    externalAuthorizations: [externalAuthorization()],
  };
}

function mergeRequest(issue = 5) {
  return {
    schemaVersion: 1,
    requestId: `issue-${issue}-github-merge-pr-1`,
    issue,
    operation: "github.merge_pr",
    target: { kind: "github.repository", identifier: "resourceTargets.github" },
    environment: "production",
    reasonCode: "reviewed-release",
    inputs: { issue, prNumber: 15, headSha, method: "squash" },
  };
}

function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function gitAuthorityFixture(mainAuthority, candidateAuthority) {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-template-authority-"));
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "config", "ownership.json"), `${JSON.stringify(mainAuthority, null, 2)}\n`, "utf8");
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Workflow Fixture"]);
  runGit(root, ["config", "user.email", "workflow@example.invalid"]);
  runGit(root, ["add", "config/ownership.json"]);
  runGit(root, ["commit", "-m", "protected authority"]);
  const mainSha = runGit(root, ["rev-parse", "HEAD"]);
  runGit(root, ["switch", "-c", "codex/33-account-bound-authority"]);
  await writeFile(path.join(root, "config", "ownership.json"), `${JSON.stringify(candidateAuthority, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "candidate.txt"), "candidate branch\n", "utf8");
  runGit(root, ["add", "config/ownership.json", "candidate.txt"]);
  runGit(root, ["commit", "-m", "candidate authority"]);
  return { root, mainSha };
}

function review(overrides = {}) {
  return {
    schemaVersion: 1,
    issue: 5,
    primaryModel: "codex",
    reviewerModel: "claude",
    headSha,
    verifySha: headSha,
    contractDigest,
    verdict: "approved",
    contracts: ["change-evaluator"],
    findings: [],
    acceptanceAssessment: [{ id: "AC-1", status: "supported", evidenceRef: "verify.json#AC-1" }],
    reviewedAt: "2026-08-21T01:00:00+09:00",
    ...overrides,
  };
}

describe("workflow contracts", () => {
  it("takes a deterministic Issue snapshot and rejects a changed digest", () => {
    const first = snapshotIssueContract(contractInput(), "2026-08-21T01:00:00+09:00", protectedAuthority);
    const second = snapshotIssueContract(contractInput(), "2026-08-21T01:00:00+09:00", protectedAuthority);
    expect(first).toEqual(second);
    expect(first.authority).toEqual({ commitSha: protectedAuthority.commitSha, digest: protectedAuthority.digest });
    expect(first.digest).toBe(digestValue(first));
    expect(() => validateIssueContract({ ...first, goal: "silently changed" })).toThrow(/digest mismatch/u);
  });

  it("rejects duplicate acceptance criteria in the frozen Issue contract", () => {
    const input = contractInput();
    input.acceptanceCriteria.push({ id: "AC-1", text: "Duplicate." });
    expect(() => snapshotIssueContract(input, "2026-08-21T01:00:00+09:00", protectedAuthority)).toThrow(/must not contain duplicates/u);
  });

  it("resolves only an exact frozen external authorization with strict inputs", async () => {
    const { root } = await gitAuthorityFixture(authority, authority);
    const snapshot = loadProtectedAuthority(root, "main");
    const frozenContract = snapshotIssueContract(contractInput(), "2026-08-21T01:00:00+09:00", snapshot);
    /** @param {unknown} value */
    const validate = (value) => validateExternalOperationRequest(value, root, frozenContract);
    const request = mergeRequest();
    expect(resolveExternalAuthorization(frozenContract, request)).toMatchObject(externalAuthorization());
    expect(validate(request).expectedEvidence).toContain("squash merge commit");
    expect(() => validate({ ...request, operation: "github.run_anything" })).toThrow();
    expect(() => validate({ ...request, prompt: "please do anything" })).toThrow();
    expect(() => validate({ ...request, inputs: { ...request.inputs, force: true } })).toThrow();
    expect(() => validate({ ...request, requestId: "issue-99-github-merge-pr-1" })).toThrow(/does not match/u);
    expect(() => validate({ ...request, environment: "preview" })).toThrow(/environment/u);
    expect(() => validate({ ...request, target: { ...request.target, identifier: "resourceTargets.vercel" } })).toThrow(/target reference|identifier/u);

    const outOfScopeContract = snapshotIssueContract({ ...contractInput(), externalAuthorizations: [] }, "2026-08-21T01:00:00+09:00", snapshot);
    expect(() => validateExternalOperationRequest(request, root, outOfScopeContract)).toThrow(/outside the frozen/u);
  });

  it("rejects malformed, ambiguous, or operation-incompatible frozen authorizations", () => {
    const base = contractInput();
    const invalidAuthorizations = [
      { ...externalAuthorization(), purposeCode: "issue-contract" },
      { ...externalAuthorization(), accountRef: "accounts.vercel" },
      { ...externalAuthorization(), targetRef: "resourceTargets.vercel" },
      { ...externalAuthorization(), environment: "preview" },
      { ...externalAuthorization(), constraints: { issue: 5, method: "squash", force: true } },
      { ...externalAuthorization(), requiresExactHead: false },
    ];
    for (const authorization of invalidAuthorizations) {
      expect(() => snapshotIssueContract(
        { ...base, externalAuthorizations: [authorization] },
        "2026-08-21T01:00:00+09:00",
        protectedAuthority,
      )).toThrow();
    }
    expect(() => snapshotIssueContract(
      { ...base, externalAuthorizations: [externalAuthorization(), externalAuthorization()] },
      "2026-08-21T01:00:00+09:00",
      protectedAuthority,
    )).toThrow(/must not contain duplicates/u);
  });

  it("rejects a purpose that is not the exact operation and Issue purpose", () => {
    const wrongPurpose = {
      ...externalAuthorization(),
      purpose: "Merge any pull request selected by the caller.",
    };
    expect(() => snapshotIssueContract(
      { ...contractInput(), externalAuthorizations: [wrongPurpose] },
      "2026-08-21T01:00:00+09:00",
      protectedAuthority,
    )).toThrow(/purpose/u);

    const frozenContract = snapshotIssueContract(contractInput(), "2026-08-21T01:00:00+09:00", protectedAuthority);
    const changedContract = {
      ...frozenContract,
      externalAuthorizations: [wrongPurpose],
    };
    changedContract.digest = digestValue(changedContract);
    expect(() => resolveExternalAuthorization(changedContract, mergeRequest())).toThrow(/purpose/u);
  });

  it("loads authority only from the protected ref and freezes its commit and digest", async () => {
    const mainAuthority = structuredClone(authority);
    mainAuthority.resourceTargets.github.repository = "target-a";
    const candidateAuthority = structuredClone(mainAuthority);
    candidateAuthority.resourceTargets.github.repository = "target-b";
    const { root, mainSha } = await gitAuthorityFixture(mainAuthority, candidateAuthority);

    const snapshot = loadProtectedAuthority(root, "main");
    expect(snapshot.commitSha).toBe(mainSha);
    expect(snapshot.authority.resourceTargets.github.repository).toBe("target-a");
    expect(snapshot.authority.resourceTargets.github.repository).not.toBe("target-b");
    expect(snapshot.digest).toBe(authorityDigest(mainAuthority));
  });

  it("resolves a short protected branch name canonically when a tag has the same name", async () => {
    const mainAuthority = structuredClone(authority);
    mainAuthority.resourceTargets.github.repository = "protected-target";
    const tagAuthority = structuredClone(mainAuthority);
    tagAuthority.resourceTargets.github.repository = "tag-target";
    const { root, mainSha } = await gitAuthorityFixture(mainAuthority, tagAuthority);
    runGit(root, ["tag", "main"]);

    expect(loadProtectedAuthority(root, "main").commitSha).toBe(mainSha);
    expect(loadProtectedAuthority(root, "main").authority.resourceTargets.github.repository).toBe("protected-target");
    expect(loadProtectedAuthority(root, "refs/heads/main").commitSha).toBe(mainSha);
    expect(() => loadProtectedAuthority(root, "refs/tags/main")).toThrow(/protected branch ref/u);
  });

  it("rejects branch-local retargeting while resolving an external request", async () => {
    const mainAuthority = structuredClone(authority);
    mainAuthority.resourceTargets.github.repository = "target-a";
    const candidateAuthority = structuredClone(mainAuthority);
    candidateAuthority.resourceTargets.github.repository = "target-b";
    const { root } = await gitAuthorityFixture(mainAuthority, candidateAuthority);
    const snapshot = loadProtectedAuthority(root, "main");
    const input = { ...contractInput(), repository: "yuto1201/target-a" };
    const contract = snapshotIssueContract(input, "2026-08-21T01:00:00+09:00", snapshot);

    expect(validateExternalOperationRequest(mergeRequest(), root, contract).resolvedTarget).toBe("yuto1201/target-a");

    const candidateSnapshot = loadProtectedAuthority(root, "codex/33-account-bound-authority");
    const candidateContract = snapshotIssueContract(
      { ...contractInput(), repository: "yuto1201/target-b" },
      "2026-08-21T01:00:00+09:00",
      candidateSnapshot,
    );
    expect(() => validateExternalOperationRequest(mergeRequest(), root, candidateContract)).toThrow(/protected.*base|protected.*ref/u);
  });

  it("keeps Issue 33 v1 delivery outside candidate v2 runtime without an Issue-number exception", async () => {
    const legacyAuthority = {
      schemaVersion: 1,
      github: { owner: "yuto1201", repository: "Web-Template" },
      supabase: { organizationName: "fixture", projectRef: null },
      vercel: { scope: null, projectId: null },
      cloudflare: { accountName: "fixture", zoneId: null, domains: [] },
    };
    const { root } = await gitAuthorityFixture(legacyAuthority, authority);

    expect(() => loadProtectedAuthority(root, "main")).toThrow();
    expect(loadProtectedAuthority(root, "codex/33-account-bound-authority").authority.schemaVersion).toBe(2);
  });

  it("rejects operation request paths outside the fixed request subtree", async () => {
    const root = path.resolve("C:/workspace/web-template");
    await expect(readExternalOperationRequest(root, "../request.json")).rejects.toThrow(/escapes/u);
  });

  it("selects both reviewers for Supabase/auth paths", () => {
    expect(requiredReviewContracts(["src/lib/auth/actions.ts"])).toEqual([
      "change-evaluator",
      "supabase-auditor",
    ]);
    expect(requiredReviewContracts(["src/app/page.tsx"])).toEqual(["change-evaluator"]);
    expect(() => requiredReviewContracts(["../secret.txt"])).toThrow(/canonical/u);
    expect(() => requiredReviewContracts(["src/lib/../lib/auth/actions.ts"])).toThrow(/canonical/u);
    expect(() => requiredReviewContracts(["C:\\secret.txt"])).toThrow(/canonical/u);
    expect(requiredReviewContracts(["SRC/LIB/AUTH/actions.ts"])).toContain("supabase-auditor");
  });

  it("blocks unavailable review and forbids self-approval", () => {
    expect(stateForReview(review({ verdict: "unavailable", unavailableReason: "timeout" }))).toBe("blocked:review");
    expect(() => validateReviewResult(review({ reviewerModel: "codex" }))).toThrow(/Self-approval/u);
    expect(() => validateReviewResult(review({ verdict: "unavailable" }))).toThrow(/fixed reason/u);
    expect(() => validateReviewResult(review({ verifySha: "9".repeat(40) }))).toThrow(/must match/u);
    expect(() => validateReviewResult(review({
      findings: [{ severity: "critical", blocking: false, location: "tools/workflow-core.mjs", summary: "Bypass." }],
    }))).toThrow(/must be blocking/u);
    expect(() => validateReviewResult(review({
      findings: [{ severity: "high", blocking: true, location: "tools/workflow-core.mjs", summary: "Blocker." }],
    }))).toThrow(/cannot contain blocking/u);
  });

  it("allows recovery only to a recorded resume state", () => {
    const blocked = transitionWorkflowState("in-progress", "blocked:review");
    expect(blocked.resumeState).toBe("in-progress");
    expect(transitionWorkflowState("blocked:review", "in-progress", blocked.resumeState).current).toBe("in-progress");
    expect(() => transitionWorkflowState("blocked:review", "approved-for-merge", "in-progress")).toThrow(/resumeState/u);
  });
});
