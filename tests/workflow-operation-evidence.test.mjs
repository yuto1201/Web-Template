import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectorIdentityFor,
  digestValue,
  readExternalOperationRequest,
  readExternalOperationResult,
  snapshotIssueContract,
  validateExternalOperationRequest,
  validateExternalOperationResult,
} from "../tools/workflow-core.mjs";

const issue = 5;

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "operation-evidence-"));
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "config", "ownership.json"), `${JSON.stringify({
    schemaVersion: 1,
    github: { owner: "yuto1201", repository: "Web-Template" },
    supabase: { organizationName: "fixture", projectRef: "abcdefghijklmnopqrst" },
    vercel: { scope: "fixture-scope", projectId: "fixture-project" },
    cloudflare: { accountId: "0".repeat(32), accountName: "fixture", zoneId: "1".repeat(32), domains: ["fixture.example.com"] },
  }, null, 2)}\n`, "utf8");
  const contract = snapshotIssueContract({
    schemaVersion: 1,
    issue,
    repository: "yuto1201/Web-Template",
    goal: "Validate operation evidence.",
    acceptanceCriteria: [{ id: "AC-1", text: "Evidence is exact." }],
    dependencies: [],
    externalOperations: ["github.read_issue"],
  }, "2026-08-22T01:00:00+09:00");
  await mkdir(path.join(root, ".artifacts", "issues", String(issue)), { recursive: true });
  await writeFile(path.join(root, ".artifacts", "issues", String(issue), "issue-contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  return { root, contract };
}

/** @param {ReturnType<typeof snapshotIssueContract>} contract */
function request(contract) {
  return {
    schemaVersion: 2,
    requestId: "issue-5-github-read-issue-1",
    issue,
    operation: "github.read_issue",
    authority: {
      executionSurface: "codex-local",
      runId: "local-issue-5-evidence",
      contractDigest: contract.digest,
      activationEvidenceRef: null,
      connectorIdentity: connectorIdentityFor("github", "yuto1201"),
    },
    environment: "none",
    reasonCode: "issue-contract",
    inputs: { issue },
  };
}

/** @param {ReturnType<typeof validateExternalOperationRequest>} validated */
function result(validated) {
  const completedAt = "2026-08-22T01:10:00+09:00";
  return {
    schemaVersion: 1,
    requestId: validated.requestId,
    requestDigest: validated.requestDigest,
    issue: validated.issue,
    operation: validated.operation,
    executionSurface: validated.authority.executionSurface,
    runId: validated.authority.runId,
    contractDigest: validated.authority.contractDigest,
    connectorIdentity: validated.authority.connectorIdentity,
    resolvedTarget: { kind: validated.resolvedTargetKind, value: validated.resolvedTarget },
    inputDigest: validated.inputDigest,
    mutationDigest: validated.mutationDigest,
    reversibility: validated.reversibility,
    status: "succeeded",
    outcome: { code: "completed", summary: "Issue snapshot matched the request.", evidenceDigest: digestValue({ snapshot: "redacted" }) },
    postState: {
      status: "verified",
      collectorRunId: "local-issue-5-post-state",
      targetDigest: digestValue({ kind: validated.resolvedTargetKind, value: validated.resolvedTarget }),
      evidenceDigest: digestValue({ observed: "issue-readable" }),
      observedAt: "2026-08-22T01:11:00+09:00",
    },
    completedAt,
  };
}

describe("external operation evidence", () => {
  it("binds a successful Codex result to the canonical validated request", async () => {
    const { root, contract } = await fixtureRoot();
    const rawRequest = request(contract);
    const validated = validateExternalOperationRequest(rawRequest, root, contract);
    expect(validateExternalOperationResult(result(validated), validated)).toMatchObject({ status: "succeeded" });
    await mkdir(path.join(root, ".artifacts", "ops-requests"), { recursive: true });
    await mkdir(path.join(root, ".artifacts", "ops-results"), { recursive: true });
    await writeFile(path.join(root, ".artifacts", "ops-requests", `${rawRequest.requestId}.json`), `${JSON.stringify(rawRequest)}\n`, "utf8");
    await writeFile(path.join(root, ".artifacts", "ops-results", `${rawRequest.requestId}.result.json`), `${JSON.stringify(result(validated))}\n`, "utf8");
    await expect(readExternalOperationResult(root, `.artifacts/ops-results/${rawRequest.requestId}.result.json`)).resolves.toMatchObject({ requestId: rawRequest.requestId });
    const cli = spawnSync(process.execPath, [
      path.resolve("tools/issue-workflow.mjs"),
      "validate-result",
      "--root",
      root,
      "--file",
      `.artifacts/ops-results/${rawRequest.requestId}.result.json`,
    ], { encoding: "utf8", windowsHide: true });
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ requestId: rawRequest.requestId, status: "succeeded" });
    const resultPath = path.join(root, ".artifacts", "ops-results", `${rawRequest.requestId}.result.json`);
    const outsideResult = path.join(root, "outside-result.json");
    await writeFile(outsideResult, `${JSON.stringify(result(validated))}\n`, "utf8");
    await rm(resultPath);
    await symlink(outsideResult, resultPath);
    await expect(readExternalOperationResult(root, `.artifacts/ops-results/${rawRequest.requestId}.result.json`)).rejects.toThrow(/escapes|non-symlink/u);
  });

  it("rejects substituted authority, mutation, identity, target, post-state, and unsafe evidence", async () => {
    const { root, contract } = await fixtureRoot();
    const validated = validateExternalOperationRequest(request(contract), root, contract);
    const valid = result(validated);
    const mutations = [
      { ...valid, requestId: "issue-5-github-read-issue-2" },
      { ...valid, requestDigest: digestValue("other") },
      { ...valid, executionSurface: "cursor-cloud" },
      { ...valid, runId: "local-other-run" },
      { ...valid, contractDigest: digestValue("other") },
      { ...valid, connectorIdentity: connectorIdentityFor("github", "other") },
      { ...valid, resolvedTarget: { ...valid.resolvedTarget, value: "other/repository" } },
      { ...valid, inputDigest: digestValue("other") },
      { ...valid, mutationDigest: digestValue("other") },
      { ...valid, postState: null },
      { ...valid, postState: { ...valid.postState, status: false } },
      { ...valid, extra: true },
      { ...valid, outcome: { ...valid.outcome, summary: ["github", "pat", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_") } },
    ];
    for (const mutation of mutations) expect(() => validateExternalOperationResult(mutation, validated)).toThrow();

    await mkdir(path.join(root, ".artifacts", "ops-requests"), { recursive: true });
    const requestPath = path.join(root, ".artifacts", "ops-requests", `${validated.requestId}.json`);
    await writeFile(path.join(root, "outside.json"), `${JSON.stringify(request(contract))}\n`, "utf8");
    await symlink(path.join(root, "outside.json"), requestPath);
    await expect(readExternalOperationRequest(root, `.artifacts/ops-requests/${validated.requestId}.json`)).rejects.toThrow(/escapes|non-symlink/u);
  });

  it("blocks Claude and Cursor without a canonical activation reference", async () => {
    const { root, contract } = await fixtureRoot();
    const raw = request(contract);
    expect(() => validateExternalOperationRequest({
      ...raw,
      authority: { ...raw.authority, executionSurface: "claude-local" },
    }, root, contract)).toThrow(/not an authorized provider operator/u);
    expect(() => validateExternalOperationRequest({
      ...raw,
      authority: { ...raw.authority, executionSurface: "cursor-cloud", runId: "bc-00000000-0000-0000-0000-000000000005" },
    }, root, contract)).toThrow(/requires activation evidence/u);
  });

  it("accepts Cursor only with fresh run-bound activation and exact provider ownership", async () => {
    const { root, contract } = await fixtureRoot();
    const runId = "bc-00000000-0000-0000-0000-000000000005";
    const activationEvidenceRef = `.artifacts/cursor-activation/${runId}.json`;
    await mkdir(path.join(root, ".artifacts", "cursor-activation"), { recursive: true });
    await writeFile(path.join(root, activationEvidenceRef), `${JSON.stringify({
      schemaVersion: 1,
      surface: "cursor-cloud",
      run: { id: runId, modelObserved: "composer-2.5" },
      repository: { fullName: "yuto1201/Web-Template", branch: "cursor/5-evidence", headSha: "2".repeat(40) },
      build: { status: "ready", node: "24.13.0", npm: "11.6.2", docker: true, chromium: true },
      reviewers: {
        openai: { observed: "gpt-5.6-sol", repositoryReadProbe: "passed", fileProbe: "denied", shellProbe: "denied", providerToolProbe: "denied", completionProbe: "passed" },
        anthropic: { observed: "claude-opus-5", repositoryReadProbe: "passed", fileProbe: "denied", shellProbe: "denied", providerToolProbe: "denied", completionProbe: "passed" },
      },
      providers: {
        github: { owner: "yuto1201", fullName: "yuto1201/Web-Template", status: "verified" },
        supabase: { organizationName: "fixture", projectRef: "abcdefghijklmnopqrst", status: "verified" },
        vercel: { scope: "fixture-scope", projectId: "fixture-project", status: "verified" },
        cloudflare: { accountId: "0".repeat(32), accountName: "fixture", zoneId: "1".repeat(32), domain: "fixture.example.com", status: "verified" },
      },
      verifiedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    const raw = request(contract);
    const cursorRequest = {
      ...raw,
      authority: { ...raw.authority, executionSurface: "cursor-cloud", runId, activationEvidenceRef },
    };
    expect(validateExternalOperationRequest(cursorRequest, root, contract)).toMatchObject({
      authority: { executionSurface: "cursor-cloud", runId },
      resolvedTarget: "yuto1201/Web-Template",
    });
  });
});
