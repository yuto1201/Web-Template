import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { authorityDigest } from "../tools/authority-core.mjs";
import {
  claimOperationExecution,
  createOperationReceiptState,
  digestValue,
  loadProtectedAuthority,
  operationNames,
  readExternalOperationRequest,
  requiredReviewContracts,
  resolveExternalAuthorization,
  snapshotIssueContract,
  stateForReview,
  transitionWorkflowState,
  validateExternalOperationRequest,
  validateIssueContract,
  validateOperationResultEvidence,
  validateOperationResult,
  validatePreflightReceipt,
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
    operatorLabel: "codex",
    executionRole: "external-operator",
    executionSurface: "github-cli",
    inputs: { issue, prNumber: 15, headSha, method: "squash" },
  };
}

function githubObservation() {
  return {
    account: { ...authority.accounts.github, ...authority.observations.github },
    target: { ...authority.resourceTargets.github },
  };
}

/** @param {Record<string, any>} contract @param {Record<string, any>} request @param {Record<string, any>} [overrides] */
function preflightReceipt(contract, request, overrides = {}) {
  const observation = githubObservation();
  return {
    schemaVersion: 1,
    receiptId: "receipt-issue-5-github-merge-pr-1",
    requestId: request.requestId,
    service: "github",
    operatorLabel: request.operatorLabel,
    executionRole: request.executionRole,
    executionSurface: request.executionSurface,
    authorityDigest: contract.authority.digest,
    issueContractDigest: contract.digest,
    authorizationDigest: digestValue(externalAuthorization()),
    requestDigest: digestValue(request),
    mutationDigest: digestValue({ operation: request.operation, inputs: request.inputs }),
    accountObservation: observation.account,
    targetObservation: observation.target,
    observedAt: "2026-08-30T01:00:00Z",
    expiresAt: "2026-08-30T01:02:00Z",
    ...overrides,
  };
}

/** @param {Record<string, any>} receipt @param {Record<string, any>} [overrides] */
function operationResult(receipt, overrides = {}) {
  const observation = githubObservation();
  const evidence = {
    issue: 5,
    prNumber: 15,
    headSha,
    method: "squash",
    mergeCommitSha: "7".repeat(40),
    issueClosed: true,
  };
  return {
    schemaVersion: 1,
    receiptId: receipt.receiptId,
    requestId: receipt.requestId,
    service: receipt.service,
    operatorLabel: receipt.operatorLabel,
    executionRole: receipt.executionRole,
    executionSurface: receipt.executionSurface,
    authorityDigest: receipt.authorityDigest,
    issueContractDigest: receipt.issueContractDigest,
    authorizationDigest: receipt.authorizationDigest,
    requestDigest: receipt.requestDigest,
    mutationDigest: receipt.mutationDigest,
    preflight: {
      accountObservation: observation.account,
      targetObservation: observation.target,
      observedAt: receipt.observedAt,
    },
    postflight: {
      accountObservation: observation.account,
      targetObservation: observation.target,
      observedAt: "2026-08-30T01:01:30Z",
    },
    outcome: {
      status: "succeeded",
      evidence,
      evidenceDigest: digestValue(evidence),
    },
    ...overrides,
  };
}

/** @param {string} root @param {string[]} args */
function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

/** @param {Record<string, any>} mainAuthority @param {Record<string, any>} candidateAuthority */
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
    primaryOperatorLabel: "codex",
    reviewerOperatorLabel: "claude",
    primaryModelFamily: "gpt",
    reviewerModelFamily: "claude",
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
    expect(() => validate({ ...request, accountObservation: githubObservation().account })).toThrow();
    expect(() => validate({ ...request, inputs: { ...request.inputs, force: true } })).toThrow();
    expect(() => validate({ ...request, requestId: "issue-99-github-merge-pr-1" })).toThrow(/does not match/u);
    expect(() => validate({ ...request, environment: "preview" })).toThrow(/environment/u);
    expect(() => validate({ ...request, target: { ...request.target, identifier: "resourceTargets.vercel" } })).toThrow(/target reference|identifier/u);

    const outOfScopeContract = snapshotIssueContract({ ...contractInput(), externalAuthorizations: [] }, "2026-08-21T01:00:00+09:00", snapshot);
    expect(() => validateExternalOperationRequest(request, root, outOfScopeContract)).toThrow(/outside the frozen/u);
  });

  it("validates a fresh preflight against protected authority and returns only redacted evidence", async () => {
    const { root } = await gitAuthorityFixture(authority, authority);
    const contract = snapshotIssueContract(contractInput(), "2026-08-21T01:00:00+09:00", loadProtectedAuthority(root, "main"));
    const request = mergeRequest();
    const receiptState = createOperationReceiptState();
    const validated = validatePreflightReceipt(preflightReceipt(contract, request), {
      root,
      contract,
      request,
      executionSurface: "github-cli",
      now: "2026-08-30T01:01:00Z",
      receiptState,
    });

    expect(validated).toMatchObject({
      ok: true,
      receiptId: "receipt-issue-5-github-merge-pr-1",
      issue: 5,
      service: "github",
      accountRefDigest: expect.stringMatching(/^sha256:/u),
      targetRefDigest: expect.stringMatching(/^sha256:/u),
    });
    expect(validated).not.toHaveProperty("accountObservation");
    expect(validated).not.toHaveProperty("targetObservation");
    expect(JSON.stringify(validated)).not.toContain(authority.accounts.github.login);
    expect(() => validatePreflightReceipt(preflightReceipt(contract, request), {
      root,
      contract,
      request,
      executionSurface: "github-cli",
      now: "2026-08-30T01:01:00Z",
      receiptState,
    })).toThrow(/reused|already been validated/u);
  });

  it("rejects stale, mismatched, malformed, or caller-forged preflight receipts", async () => {
    const { root } = await gitAuthorityFixture(authority, authority);
    const contract = snapshotIssueContract(contractInput(), "2026-08-21T01:00:00+09:00", loadProtectedAuthority(root, "main"));
    const request = mergeRequest();
    const baseContext = {
      root,
      contract,
      request,
      executionSurface: "github-cli",
      now: "2026-08-30T01:01:00Z",
    };
    const cases = [
      [preflightReceipt(contract, request, { expiresAt: "2026-08-30T01:00:30Z" }), /expired|stale/u],
      [preflightReceipt(contract, request, { executionSurface: "browser" }), /surface/u],
      [preflightReceipt(contract, request, { authorityDigest: `sha256:${"9".repeat(64)}` }), /authority digest/u],
      [preflightReceipt(contract, request, { issueContractDigest: `sha256:${"9".repeat(64)}` }), /Issue contract digest/u],
      [preflightReceipt(contract, request, { authorizationDigest: `sha256:${"9".repeat(64)}` }), /authorization digest/u],
      [preflightReceipt(contract, request, { requestDigest: `sha256:${"9".repeat(64)}` }), /request digest/u],
      [preflightReceipt(contract, request, { mutationDigest: `sha256:${"9".repeat(64)}` }), /mutation digest/u],
      [{ ...preflightReceipt(contract, request), unexpected: true }, /unrecognized|unknown|invalid input/u],
      [preflightReceipt(contract, request, { operatorLabel: "other" }), /operator|invalid option|invalid input/u],
      [preflightReceipt(contract, request, { executionRole: "change-evaluator" }), /executionRole|invalid option|invalid input/iu],
    ];
    for (const [receipt, message] of cases) {
      expect(() => validatePreflightReceipt(receipt, {
        ...baseContext,
        receiptState: createOperationReceiptState(),
      })).toThrow(message);
    }
  });

  it("requires an atomic one-use execution claim and rejects account or target switches", async () => {
    const { root } = await gitAuthorityFixture(authority, authority);
    const contract = snapshotIssueContract(contractInput(), "2026-08-21T01:00:00+09:00", loadProtectedAuthority(root, "main"));
    const request = mergeRequest();
    const receipt = preflightReceipt(contract, request);
    const context = {
      root,
      contract,
      request,
      executionSurface: "github-cli",
      now: "2026-08-30T01:01:45Z",
    };

    expect(() => validateOperationResult(operationResult(receipt), {
      ...context,
      receiptState: createOperationReceiptState(),
    })).toThrow(/execution claim/u);

    const strictResultState = createOperationReceiptState();
    validatePreflightReceipt(receipt, { ...context, now: "2026-08-30T01:01:00Z", receiptState: strictResultState });
    claimOperationExecution(receipt.receiptId, { receiptState: strictResultState, now: "2026-08-30T01:01:05Z" });
    expect(() => validateOperationResult({ ...operationResult(receipt), unexpected: true }, {
      ...context,
      receiptState: strictResultState,
    })).toThrow(/unrecognized|unknown|invalid input/u);

    const accountSwitchState = createOperationReceiptState();
    validatePreflightReceipt(receipt, { ...context, now: "2026-08-30T01:01:00Z", receiptState: accountSwitchState });
    claimOperationExecution(receipt.receiptId, { receiptState: accountSwitchState, now: "2026-08-30T01:01:05Z" });
    const accountSwitch = operationResult(receipt);
    accountSwitch.preflight.accountObservation = { ...accountSwitch.preflight.accountObservation, login: "company-user" };
    expect(() => validateOperationResult(accountSwitch, { ...context, receiptState: accountSwitchState })).toThrow(/account switch/u);

    const targetSwitchState = createOperationReceiptState();
    validatePreflightReceipt(receipt, { ...context, now: "2026-08-30T01:01:00Z", receiptState: targetSwitchState });
    claimOperationExecution(receipt.receiptId, { receiptState: targetSwitchState, now: "2026-08-30T01:01:05Z" });
    const targetSwitch = operationResult(receipt);
    targetSwitch.preflight.targetObservation = { ...targetSwitch.preflight.targetObservation, repositoryId: 99 };
    expect(() => validateOperationResult(targetSwitch, { ...context, receiptState: targetSwitchState })).toThrow(/target switch/u);

    const receiptState = createOperationReceiptState();
    validatePreflightReceipt(receipt, { ...context, now: "2026-08-30T01:01:00Z", receiptState });
    expect(claimOperationExecution(receipt.receiptId, {
      receiptState,
      now: "2026-08-30T01:01:05Z",
    })).toMatchObject({
      ok: true,
      status: "claimed",
      requestDigest: receipt.requestDigest,
      mutationDigest: receipt.mutationDigest,
    });
    const validated = validateOperationResult(operationResult(receipt), { ...context, receiptState });
    expect(validated).toMatchObject({ ok: true, consumed: true, outcome: "succeeded" });
    expect(validated).not.toHaveProperty("preflight");
    expect(validated).not.toHaveProperty("postflight");
    expect(() => validateOperationResult(operationResult(receipt), { ...context, receiptState })).toThrow(/consumed|reuse/u);
  });

  it("blocks the same mutation under another receipt ID and keeps ambiguous outcomes terminal", async () => {
    const { root } = await gitAuthorityFixture(authority, authority);
    const contract = snapshotIssueContract(contractInput(), "2026-08-21T01:00:00+09:00", loadProtectedAuthority(root, "main"));
    const request = mergeRequest();
    const first = preflightReceipt(contract, request);
    const second = preflightReceipt(contract, request, { receiptId: "receipt-issue-5-github-merge-pr-2" });
    const receiptState = createOperationReceiptState();
    const context = { root, contract, request, executionSurface: "github-cli", receiptState };

    validatePreflightReceipt(first, { ...context, now: "2026-08-30T01:01:00Z" });
    validatePreflightReceipt(second, { ...context, now: "2026-08-30T01:01:00Z" });
    claimOperationExecution(first.receiptId, { receiptState, now: "2026-08-30T01:01:05Z" });
    expect(() => claimOperationExecution(second.receiptId, {
      receiptState,
      now: "2026-08-30T01:01:06Z",
    })).toThrow(/mutation.*already.*claimed|retry.*forbidden/u);

    const evidence = {
      operation: request.operation,
      reasonCode: "PROVIDER_RESPONSE_UNKNOWN",
      providerState: "unknown",
      detailDigest: `sha256:${"6".repeat(64)}`,
    };
    const ambiguous = operationResult(first, {
      outcome: {
        status: "ambiguous",
        retryPolicy: "inspect-provider-state-only",
        evidence,
        evidenceDigest: digestValue(evidence),
      },
    });
    expect(validateOperationResult(ambiguous, {
      ...context,
      now: "2026-08-30T01:01:45Z",
    })).toMatchObject({ outcome: "ambiguous", retryPolicy: "inspect-provider-state-only" });
    expect(() => claimOperationExecution(second.receiptId, {
      receiptState,
      now: "2026-08-30T01:01:46Z",
    })).toThrow(/mutation.*terminal|retry.*forbidden/u);
  });

  it("recomputes strict operation evidence and permits a fresh result after a long operation", async () => {
    const { root } = await gitAuthorityFixture(authority, authority);
    const contract = snapshotIssueContract(contractInput(), "2026-08-21T01:00:00+09:00", loadProtectedAuthority(root, "main"));
    const request = mergeRequest();
    const receipt = preflightReceipt(contract, request);
    const expiredState = createOperationReceiptState();
    validatePreflightReceipt(receipt, {
      root,
      contract,
      request,
      executionSurface: "github-cli",
      receiptState: expiredState,
      now: "2026-08-30T01:01:00Z",
    });
    expect(() => claimOperationExecution(receipt.receiptId, {
      receiptState: expiredState,
      now: receipt.expiresAt,
    })).toThrow(/expired|stale/u);

    const receiptState = createOperationReceiptState();
    const context = { root, contract, request, executionSurface: "github-cli", receiptState };
    validatePreflightReceipt(receipt, { ...context, now: "2026-08-30T01:01:00Z" });
    claimOperationExecution(receipt.receiptId, { receiptState, now: "2026-08-30T01:01:05Z" });

    const beforeStart = operationResult(receipt);
    beforeStart.postflight.observedAt = "2026-08-30T01:01:05Z";
    expect(() => validateOperationResult(beforeStart, {
      ...context,
      now: "2026-08-30T01:01:20Z",
    })).toThrow(/after execution startedAt/u);

    const stalePostflight = operationResult(receipt);
    stalePostflight.postflight.observedAt = "2026-08-30T01:58:00Z";
    expect(() => validateOperationResult(stalePostflight, {
      ...context,
      now: "2026-08-30T02:00:01Z",
    })).toThrow(/stale/u);

    const forged = operationResult(receipt);
    forged.postflight.observedAt = "2026-08-30T02:00:30Z";
    forged.outcome.evidenceDigest = `sha256:${"9".repeat(64)}`;
    expect(() => validateOperationResult(forged, {
      ...context,
      now: "2026-08-30T02:00:45Z",
    })).toThrow(/evidence digest/u);

    const malformed = operationResult(receipt);
    malformed.postflight.observedAt = "2026-08-30T02:00:30Z";
    /** @type {Record<string, any>} */ (malformed.outcome.evidence).force = true;
    expect(() => validateOperationResult(malformed, {
      ...context,
      now: "2026-08-30T02:00:45Z",
    })).toThrow(/unrecognized|unknown|invalid input/u);

    const wrongMutationEvidence = operationResult(receipt);
    wrongMutationEvidence.postflight.observedAt = "2026-08-30T02:00:30Z";
    wrongMutationEvidence.outcome.evidence.prNumber = 16;
    wrongMutationEvidence.outcome.evidenceDigest = digestValue(wrongMutationEvidence.outcome.evidence);
    expect(() => validateOperationResult(wrongMutationEvidence, {
      ...context,
      now: "2026-08-30T02:00:45Z",
    })).toThrow(/frozen mutation request/u);

    const longRunning = operationResult(receipt);
    longRunning.postflight.observedAt = "2026-08-30T02:00:30Z";
    expect(validateOperationResult(longRunning, {
      ...context,
      now: "2026-08-30T02:00:45Z",
    })).toMatchObject({ ok: true, outcome: "succeeded" });

    const failureReceipt = preflightReceipt(contract, request, { receiptId: "receipt-issue-5-github-merge-pr-3" });
    const failureState = createOperationReceiptState();
    const failureContext = { ...context, receiptState: failureState };
    validatePreflightReceipt(failureReceipt, { ...failureContext, now: "2026-08-30T01:01:00Z" });
    claimOperationExecution(failureReceipt.receiptId, { receiptState: failureState, now: "2026-08-30T01:01:05Z" });
    const failureEvidence = {
      operation: request.operation,
      errorCode: "PROVIDER_REJECTED",
      providerState: "unchanged",
      detailDigest: `sha256:${"5".repeat(64)}`,
    };
    const failed = operationResult(failureReceipt, {
      postflight: {
        accountObservation: githubObservation().account,
        targetObservation: githubObservation().target,
        observedAt: "2026-08-30T01:01:10Z",
      },
      outcome: {
        status: "failed",
        retryPolicy: "forbidden",
        evidence: failureEvidence,
        evidenceDigest: digestValue(failureEvidence),
      },
    });
    expect(validateOperationResult(failed, {
      ...failureContext,
      now: "2026-08-30T01:01:20Z",
    })).toMatchObject({ outcome: "failed", retryPolicy: "forbidden", finalized: true });
  });

  it("binds every registered operation success field to its frozen mutation inputs", () => {
    const targetRef = "frozen-provider-target";
    const targetDigest = digestValue(targetRef);
    const sha = "2".repeat(40);
    const timestamp = "2026-08-30T01:01:30Z";
    const migration = "supabase/migrations/20260830010101_create_receipts.sql";
    const cases = [
      {
        operation: "github.read_issue",
        inputs: { issue: 5 },
        evidence: { issue: 5, state: "OPEN", updatedAt: timestamp },
      },
      {
        operation: "github.push_branch",
        inputs: { branch: "codex/33-account-bound-authority", headSha: sha },
        evidence: { branch: "codex/33-account-bound-authority", headSha: sha },
      },
      {
        operation: "github.create_pr",
        inputs: { issue: 5, branch: "codex/33-account-bound-authority", baseBranch: "main", headSha: sha },
        evidence: { issue: 5, branch: "codex/33-account-bound-authority", baseBranch: "main", headSha: sha, prNumber: 34, state: "OPEN" },
      },
      {
        operation: "github.merge_pr",
        inputs: { issue: 5, prNumber: 34, headSha: sha, method: "squash" },
        evidence: { issue: 5, prNumber: 34, headSha: sha, method: "squash", mergeCommitSha: "7".repeat(40), issueClosed: true },
      },
      {
        operation: "github.delete_branch",
        inputs: { branch: "codex/33-account-bound-authority", mergedPrNumber: 34, headSha: sha },
        evidence: { branch: "codex/33-account-bound-authority", mergedPrNumber: 34, headSha: sha, deleted: true },
      },
      {
        operation: "github.update_ruleset",
        inputs: { issue: 5, rulesetName: "main exact-Head review", targetBranch: "main", requiredCheckName: "Exact Head review policy", enforcement: "active" },
        evidence: { issue: 5, rulesetName: "main exact-Head review", targetBranch: "main", requiredCheckName: "Exact Head review policy", enforcement: "active", rulesetId: 9 },
      },
      {
        operation: "supabase.inspect_project",
        inputs: { projectRefSource: "config/ownership.json" },
        evidence: { projectRefSource: "config/ownership.json", projectRefDigest: targetDigest, status: "reachable" },
      },
      {
        operation: "supabase.apply_migrations",
        inputs: { projectRefSource: "config/ownership.json", migrations: [migration] },
        evidence: { projectRefSource: "config/ownership.json", projectRefDigest: targetDigest, appliedMigrations: [migration] },
      },
      {
        operation: "vercel.inspect_project",
        inputs: { projectSource: "config/ownership.json" },
        evidence: { projectSource: "config/ownership.json", projectIdDigest: targetDigest, status: "reachable" },
      },
      {
        operation: "vercel.deploy_preview",
        inputs: { projectSource: "config/ownership.json", headSha: sha },
        evidence: { projectSource: "config/ownership.json", deploymentId: "dpl_preview", projectIdDigest: targetDigest, headSha: sha, environment: "preview" },
      },
      {
        operation: "vercel.deploy_production",
        inputs: { projectSource: "config/ownership.json", headSha: sha },
        evidence: { projectSource: "config/ownership.json", deploymentId: "dpl_production", projectIdDigest: targetDigest, headSha: sha, environment: "production" },
      },
      {
        operation: "cloudflare.inspect_zone",
        inputs: { zoneSource: "config/ownership.json" },
        evidence: { zoneSource: "config/ownership.json", zoneIdDigest: targetDigest, zonePlan: "Free", recordSetDigest: `sha256:${"8".repeat(64)}` },
        postTarget: { zonePlan: "Free" },
      },
      {
        operation: "cloudflare.upsert_dns",
        inputs: { zoneSource: "config/ownership.json", recordName: "www.example.com", recordType: "CNAME", target: "example.vercel-dns.com", proxied: false },
        evidence: { zoneSource: "config/ownership.json", recordId: "dns_record_1", zoneIdDigest: targetDigest, recordName: "www.example.com", recordType: "CNAME", target: "example.vercel-dns.com", proxied: false },
      },
    ];
    /** @param {string} field @param {unknown} value */
    const alternate = (field, value) => {
      if (field === "branch") return "codex/33-account-bound-authority-other";
      if (field === "headSha") return "9".repeat(40);
      if (field === "recordType") return "AAAA";
      if (field === "recordName") return "api.example.com";
      if (field === "target") return "other.vercel-dns.com";
      if (field === "migrations") return [migration, "supabase/migrations/20260830010102_other.sql"];
      if (typeof value === "number") return value + 1;
      if (typeof value === "boolean") return !value;
      return `${value}-other`;
    };
    expect(cases.map(({ operation }) => operation)).toEqual(operationNames);

    for (const [index, testCase] of cases.entries()) {
      const outcome = {
        status: "succeeded",
        evidence: testCase.evidence,
        evidenceDigest: digestValue(testCase.evidence),
      };
      expect(validateOperationResultEvidence(testCase.operation, outcome, {
        inputs: testCase.inputs,
        targetRef,
        postTarget: testCase.postTarget,
      })).toEqual(outcome);

      for (const [inputField, inputValue] of Object.entries(testCase.inputs)) {
        const evidenceField = inputField === "migrations" ? "appliedMigrations" : inputField;
        const changedEvidence = { ...testCase.evidence, [evidenceField]: alternate(inputField, inputValue) };
        expect(() => validateOperationResultEvidence(testCase.operation, {
          status: "succeeded",
          evidence: changedEvidence,
          evidenceDigest: digestValue(changedEvidence),
        }, {
          inputs: testCase.inputs,
          targetRef,
          postTarget: testCase.postTarget,
        })).toThrow(/frozen mutation request|invalid input|invalid option/iu);
      }

      const terminalEvidence = {
        operation: testCase.operation,
        errorCode: "PROVIDER_REJECTED",
        providerState: "unchanged",
        detailDigest: `sha256:${"6".repeat(64)}`,
      };
      expect(validateOperationResultEvidence(testCase.operation, {
        status: "failed",
        retryPolicy: "forbidden",
        evidence: terminalEvidence,
        evidenceDigest: digestValue(terminalEvidence),
      }, { inputs: testCase.inputs, targetRef, postTarget: testCase.postTarget })).toMatchObject({ status: "failed" });
      expect(() => validateOperationResultEvidence(testCase.operation, {
        status: "failed",
        retryPolicy: "forbidden",
        evidence: terminalEvidence,
        evidenceDigest: `sha256:${"0".repeat(64)}`,
      }, { inputs: testCase.inputs, targetRef, postTarget: testCase.postTarget })).toThrow(/evidence digest/u);

      const ambiguousEvidence = {
        operation: testCase.operation,
        reasonCode: "PROVIDER_RESPONSE_UNKNOWN",
        providerState: "unknown",
        detailDigest: `sha256:${"7".repeat(64)}`,
      };
      expect(validateOperationResultEvidence(testCase.operation, {
        status: "ambiguous",
        retryPolicy: "inspect-provider-state-only",
        evidence: ambiguousEvidence,
        evidenceDigest: digestValue(ambiguousEvidence),
      }, { inputs: testCase.inputs, targetRef, postTarget: testCase.postTarget })).toMatchObject({ status: "ambiguous" });
      const wrongOperationEvidence = { ...ambiguousEvidence, operation: cases[(index + 1) % cases.length].operation };
      expect(() => validateOperationResultEvidence(testCase.operation, {
        status: "ambiguous",
        retryPolicy: "inspect-provider-state-only",
        evidence: wrongOperationEvidence,
        evidenceDigest: digestValue(wrongOperationEvidence),
      }, { inputs: testCase.inputs, targetRef, postTarget: testCase.postTarget })).toThrow(/invalid input|invalid value/iu);
    }
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
    expect(() => validateReviewResult(review({ reviewerOperatorLabel: "claude", reviewerModelFamily: "gpt" }))).toThrow(/Self-approval|same model family/u);
    expect(validateReviewResult(review({ reviewerOperatorLabel: "codex" }))).toMatchObject({
      reviewerOperatorLabel: "codex",
      reviewerModelFamily: "claude",
    });
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
