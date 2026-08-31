import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planGitHubWorkflow, runGitHubWorkflow, workflowContentDigest } from "../tools/github-workflow-core.mjs";

const mocks = vi.hoisted(() => ({ factory: vi.fn(), gate: vi.fn() }));
vi.mock("../tools/github-workflow-client.mjs", () => ({ createGitHubWorkflowClient: mocks.factory }));
vi.mock("../tools/workflow-core.mjs", async (importOriginal) => ({ ...await importOriginal(), runAuthoritativePremergeGate: mocks.gate }));

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
const operations = ["list_issues", "read_issue", "create_issue", "push_branch", "read_pr", "create_pr", "update_pr", "ready_pr", "read_checks"];
const policy = { schemaVersion: 1, operations, requestTtlSeconds: 900, claimNamespace: "refs/notes/github-workflow/" };

async function fixture(trustedPolicy = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "github-workflow-test-"));
  await mkdir(path.join(root, "config"));
  const authority = JSON.parse(await readFile(path.resolve("config/ownership.json"), "utf8"));
  authority.accounts.github = { login: "fixture-user", userId: 12, nodeId: "USER_12" };
  authority.resourceTargets.github = { owner: "fixture-user", repository: "app", repositoryId: 34, repositoryNodeId: "REPO_34" };
  await writeFile(path.join(root, "config/ownership.json"), JSON.stringify(authority));
  if (trustedPolicy) await writeFile(path.join(root, "config/github-workflow.json"), JSON.stringify(policy));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Workflow fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Trusted policy"]);
  const mainSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["switch", "-c", "codex/41-workflow"]);
  if (!trustedPolicy) await writeFile(path.join(root, "config/github-workflow.json"), JSON.stringify(policy));
  await writeFile(path.join(root, "app.txt"), "change\n");
  git(root, ["add", "app.txt"]);
  git(root, ["commit", "-m", "App change"]);
  const headSha = git(root, ["rev-parse", "HEAD"]);
  /** @type {Record<string, any>} */
  const state = { remoteHead: null, issue: { number: 41, title: "Approved work", body: "AC-1: safe outcome", state: "OPEN", updatedAt: "2026-08-31T00:00:00Z", url: "https://github.com/fixture-user/app/issues/41" }, claims: new Set(), mutations: [], pull: null };
  /** @type {Record<string, any>} */
  const client = {
    observe: vi.fn(async () => ({ account: authority.accounts.github, target: authority.resourceTargets.github, mainSha })),
    issue: vi.fn(async (_repository, number) => structuredClone(number === 42 ? state.createdIssue : state.issue)),
    listIssues: vi.fn(async () => ({ items: [structuredClone(state.issue)], complete: true })),
    branch: vi.fn(async () => state.remoteHead),
    findPull: vi.fn(async () => ({ items: state.pull ? [structuredClone(state.pull)] : [], complete: true })),
    pull: vi.fn(async () => structuredClone(state.pull)),
    claim: vi.fn(async (_repository, ref, sha) => {
      if (state.claims.has(ref)) throw new Error("Claim already exists");
      state.claims.add(ref);
      return { ref, sha };
    }),
    push: vi.fn(async (input) => { state.mutations.push("push_branch"); state.remoteHead = input.headSha; return { branch: input.branch, headSha: input.headSha }; }),
    createIssue: vi.fn(async (_repository, input) => { state.mutations.push("create_issue"); state.createdIssue = { ...state.issue, number: 42, ...input, url: "https://github.com/fixture-user/app/issues/42" }; return structuredClone(state.createdIssue); }),
    createPull: vi.fn(async (_repository, input) => {
      state.mutations.push("create_pr");
      state.pull = { number: 51, nodeId: "PR_51", state: "OPEN", draft: true, baseBranch: "main", branch: input.branch, headSha: state.remoteHead, headRepositoryId: 34, title: input.title, body: input.body, url: "https://github.com/fixture-user/app/pull/51" };
      return structuredClone(state.pull);
    }),
    updatePull: vi.fn(async (_repository, _number, input) => { state.mutations.push("update_pr"); Object.assign(state.pull, input); return structuredClone(state.pull); }),
    readyPull: vi.fn(async () => { state.mutations.push("ready_pr"); state.pull.draft = false; return { nodeId: state.pull.nodeId, draft: false }; }),
    checks: vi.fn(async (_repository, sha) => ({ headSha: sha, checkRuns: [], statuses: [], complete: false })),
  };
  mocks.factory.mockReturnValue(client);
  return { root, headSha, mainSha, authority, state, client };
}

/** @param {string} operation @param {Record<string, any>} inputs @param {Record<string, any>} [extra] */
function input(operation, inputs, extra = {}) {
  return { schemaVersion: 1, operatorLabel: "codex", executionRole: "implementer", executionSurface: "codex-local", purpose: "Implement approved application work", approvalReference: "Current user request", operation, inputs, ...extra };
}

describe("guarded daily GitHub workflow", () => {
  beforeEach(() => { mocks.factory.mockReset(); mocks.gate.mockReset(); });
  afterEach(() => vi.restoreAllMocks());

  it("refuses candidate-only policy before opening any provider connection", async () => {
    const f = await fixture(false);
    const modulePath = "../tools/github-workflow-core.mjs";
    const core = await import(/* @vite-ignore */ modulePath).catch(() => null);
    expect(core, "A guarded collaboration planner must exist").not.toBeNull();
    await expect(core.planGitHubWorkflow(f.root, input("list_issues", {}))).rejects.toThrow(/protected|policy/i);
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it.each(["evaluator", "auditor"])("rejects read-only role %s before credentials", async (executionRole) => {
    const f = await fixture();
    await expect(planGitHubWorkflow(f.root, input("list_issues", {}, { executionRole }))).rejects.toThrow();
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it("rejects unsupported endpoints, targets, surfaces and absent approval", async () => {
    const f = await fixture();
    for (const value of [input("delete_branch", {}), input("list_issues", { repository: "other/repo" }), input("list_issues", {}, { endpoint: "/user" }), input("list_issues", {}, { executionSurface: "cursor-cloud" }), input("list_issues", {}, { approvalReference: "" })]) {
      await expect(planGitHubWorkflow(f.root, value)).rejects.toThrow();
    }
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it("allows bounded pre-Issue reads and preserves incomplete check evidence", async () => {
    const f = await fixture();
    const request = await planGitHubWorkflow(f.root, input("list_issues", {}));
    expect(await runGitHubWorkflow(f.root, request)).toMatchObject({ complete: true });
    const checks = await planGitHubWorkflow(f.root, input("read_checks", { headSha: f.headSha }));
    expect(await runGitHubWorkflow(f.root, checks)).toEqual({ headSha: f.headSha, checkRuns: [], statuses: [], complete: false });
    expect(f.client.claim).not.toHaveBeenCalled();
  });

  it.each(["account", "target", "main"])("rejects wrong live %s before any mutation", async (field) => {
    const f = await fixture();
    const actual = await f.client.observe();
    if (field === "account") actual.account = { ...actual.account, userId: 999 };
    if (field === "target") actual.target = { ...actual.target, repositoryId: 999 };
    if (field === "main") actual.mainSha = "a".repeat(40);
    f.client.observe.mockResolvedValue(actual);
    await expect(planGitHubWorkflow(f.root, input("create_issue", { title: "Approved proposal", body: "AC-1" }))).rejects.toThrow();
    expect(f.state.mutations).toEqual([]);
  });

  it("creates an approved proposal without a fake Issue contract and fences repeat requests", async () => {
    const f = await fixture();
    const proposal = input("create_issue", { title: "Approved proposal", body: "AC-1: bounded outcome" });
    const request = await planGitHubWorkflow(f.root, proposal);
    expect(await runGitHubWorkflow(f.root, request)).toMatchObject({ number: 42, title: "Approved proposal" });
    const repeated = await planGitHubWorkflow(f.root, proposal);
    await expect(runGitHubWorkflow(f.root, repeated)).rejects.toThrow(/no execution claim/i);
    expect(f.client.createIssue).toHaveBeenCalledTimes(1);
  });

  it("allows successive push and PR writes without evidence-only source commits", async () => {
    const f = await fixture();
    const scope = { issue: 41, branch: "codex/41-workflow", headSha: f.headSha };
    const push = await planGitHubWorkflow(f.root, input("push_branch", { ...scope, expectedHeadSha: null }));
    await runGitHubWorkflow(f.root, push);
    const pr = await planGitHubWorkflow(f.root, input("create_pr", { ...scope, title: "Implement approved work", body: "Closes #41\n\nVerification evidence" }));
    expect(await runGitHubWorkflow(f.root, pr)).toMatchObject({ number: 51, draft: true });
    expect(f.state.mutations).toEqual(["push_branch", "create_pr"]);
    expect(f.state.claims.size).toBe(2);
    expect(git(f.root, ["rev-parse", "HEAD"])).toBe(f.headSha);
    expect(git(f.root, ["status", "--porcelain"])).toBe("");
    const records = await readdir(path.join(f.root, ".git/github-workflow-v1"));
    expect(records.filter((name) => name.startsWith("result-"))).toHaveLength(2);
  });

  it.each(["issue", "head", "remote", "account"])("rejects a planned push after %s changes", async (field) => {
    const f = await fixture();
    const request = await planGitHubWorkflow(f.root, input("push_branch", { issue: 41, branch: "codex/41-workflow", headSha: f.headSha, expectedHeadSha: null }));
    if (field === "issue") f.state.issue.body = "Changed AC";
    if (field === "head") git(f.root, ["commit", "--allow-empty", "-m", "New head"]);
    if (field === "remote") f.state.remoteHead = "a".repeat(40);
    if (field === "account") f.client.observe.mockResolvedValue({ account: { ...f.authority.accounts.github, userId: 999 }, target: f.authority.resourceTargets.github, mainSha: f.mainSha });
    await expect(runGitHubWorkflow(f.root, request)).rejects.toThrow();
    expect(f.client.claim).not.toHaveBeenCalled();
    expect(f.client.push).not.toHaveBeenCalled();
  });

  it("rejects content tampering, expiry and protected-main movement before credentials", async () => {
    const f = await fixture();
    const request = await planGitHubWorkflow(f.root, input("create_issue", { title: "Approved", body: "AC-1" }));
    mocks.factory.mockClear();
    const tampered = structuredClone(request);
    Object.assign(tampered, { intent: input("create_issue", { title: "Different", body: "AC-1" }) });
    await expect(runGitHubWorkflow(f.root, tampered)).rejects.toThrow(/immutable/i);
    await expect(runGitHubWorkflow(f.root, { ...request, expiresAt: "2020-01-01T00:00:00Z" })).rejects.toThrow(/expired|lifetime/i);
    git(f.root, ["update-ref", "refs/heads/main", f.headSha]);
    await expect(runGitHubWorkflow(f.root, request)).rejects.toThrow(/stale/i);
    expect(mocks.factory).not.toHaveBeenCalled();
  });

  it("fences ambiguous remote claims across independent local journals", async () => {
    const f = await fixture();
    const proposal = input("create_issue", { title: "Approved", body: "AC-1" });
    const request = await planGitHubWorkflow(f.root, proposal);
    f.client.claim.mockImplementation(/** @param {string} _repo @param {string} ref */ async (_repo, ref) => { f.state.claims.add(ref); throw new Error("Unknown provider response with SECRET_TOKEN"); });
    await expect(runGitHubWorkflow(f.root, request)).rejects.toThrow(/inspect provider state/i);
    expect(f.client.createIssue).not.toHaveBeenCalled();
    const second = await fixture();
    second.client.claim.mockImplementation(/** @param {string} _repo @param {string} ref */ async (_repo, ref) => {
      if (f.state.claims.has(ref)) throw new Error("Already claimed remotely");
      throw new Error("Unexpected new claim digest");
    });
    await expect(runGitHubWorkflow(second.root, await planGitHubWorkflow(second.root, proposal))).rejects.toThrow(/inspect provider state/i);
    expect(second.client.createIssue).not.toHaveBeenCalled();
    expect(second.client.claim.mock.calls[0][1]).toBe(f.client.claim.mock.calls[0][1]);
    const records = await readdir(path.join(f.root, ".git/github-workflow-v1"));
    const resultFile = records.find((name) => name.startsWith("result-"));
    if (!resultFile) throw new Error("Expected finalized result");
    const result = await readFile(path.join(f.root, ".git/github-workflow-v1", resultFile), "utf8");
    expect(result).not.toContain("SECRET_TOKEN");
    expect(result).toContain("ambiguous-inspect-only");
  });

  it("rechecks identity and Issue after claiming and does not execute stale content", async () => {
    const f = await fixture();
    const request = await planGitHubWorkflow(f.root, input("push_branch", { issue: 41, branch: "codex/41-workflow", headSha: f.headSha, expectedHeadSha: null }));
    f.client.claim.mockImplementation(/** @param {string} _repo @param {string} ref @param {string} sha */ async (_repo, ref, sha) => { f.state.issue.body = "Changed during claim"; return { ref, sha }; });
    await expect(runGitHubWorkflow(f.root, request)).rejects.toThrow(/inspect provider state/i);
    expect(f.client.push).not.toHaveBeenCalled();
  });

  it("shares the atomic claim across sibling worktrees and simultaneous executions", async () => {
    const f = await fixture();
    const sibling = path.join(await mkdtemp(path.join(os.tmpdir(), "workflow-sibling-")), "tree");
    git(f.root, ["worktree", "add", "-b", "codex/42-sibling", sibling]);
    const request = await planGitHubWorkflow(f.root, input("create_issue", { title: "Approved", body: "AC-1" }));
    const attempts = await Promise.allSettled([runGitHubWorkflow(f.root, request), runGitHubWorkflow(sibling, request)]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(f.client.claim).toHaveBeenCalledTimes(1);
    expect(f.client.createIssue).toHaveBeenCalledTimes(1);
  });

  it("rejects postflight state or account mismatch without claiming success", async () => {
    const f = await fixture();
    const request = await planGitHubWorkflow(f.root, input("push_branch", { issue: 41, branch: "codex/41-workflow", headSha: f.headSha, expectedHeadSha: null }));
    f.client.push.mockImplementation(async () => ({ branch: "codex/41-workflow", headSha: f.headSha }));
    await expect(runGitHubWorkflow(f.root, request)).rejects.toThrow(/inspect provider state/i);
    const records = await readdir(path.join(f.root, ".git/github-workflow-v1"));
    const resultFile = records.find((name) => name.startsWith("result-"));
    if (!resultFile) throw new Error("Missing result");
    expect(JSON.parse(await readFile(path.join(f.root, ".git/github-workflow-v1", resultFile), "utf8")).status).toBe("ambiguous-inspect-only");
  });

  it.each([{ at: 1, claims: 0 }, { at: 2, claims: 1 }])("rechecks expiry after slow observation $at before the next side effect", async ({ at, claims }) => {
    const f = await fixture();
    const request = await planGitHubWorkflow(f.root, input("create_issue", { title: "Approved", body: "AC-1" }));
    const actual = await f.client.observe();
    let observations = 0;
    f.client.observe.mockImplementation(async () => {
      observations += 1;
      if (observations === at) vi.spyOn(Date, "now").mockReturnValue(Date.parse(request.expiresAt) + 1);
      return actual;
    });
    await expect(runGitHubWorkflow(f.root, request)).rejects.toThrow();
    expect(f.client.claim).toHaveBeenCalledTimes(claims);
    expect(f.client.createIssue).not.toHaveBeenCalled();
  });

  it("rechecks protected main after slow post-claim observations", async () => {
    const f = await fixture();
    const request = await planGitHubWorkflow(f.root, input("create_issue", { title: "Approved", body: "AC-1" }));
    const actual = await f.client.observe();
    let observations = 0;
    f.client.observe.mockImplementation(async () => {
      observations += 1;
      if (observations === 2) git(f.root, ["update-ref", "refs/heads/main", f.headSha]);
      return actual;
    });
    await expect(runGitHubWorkflow(f.root, request)).rejects.toThrow();
    expect(f.client.claim).toHaveBeenCalledTimes(1);
    expect(f.client.createIssue).not.toHaveBeenCalled();
  });

  it("rechecks expiry after the final ready gate before changing PR state", async () => {
    const f = await fixture();
    f.state.remoteHead = f.headSha;
    await f.client.createPull("fixture-user/app", { branch: "codex/41-workflow", title: "Initial", body: "Closes #41" });
    const request = await planGitHubWorkflow(f.root, input("ready_pr", { issue: 41, branch: "codex/41-workflow", headSha: f.headSha, prNumber: 51 }));
    let gates = 0;
    mocks.gate.mockImplementation(async () => {
      gates += 1;
      if (gates === 2) vi.spyOn(Date, "now").mockReturnValue(Date.parse(request.expiresAt) + 1);
      return { ok: true };
    });
    await expect(runGitHubWorkflow(f.root, request)).rejects.toThrow();
    expect(f.client.readyPull).not.toHaveBeenCalled();
  });

  it("rejects unapproved PR content changed during the ready mutation", async () => {
    const f = await fixture();
    f.state.remoteHead = f.headSha;
    await f.client.createPull("fixture-user/app", { branch: "codex/41-workflow", title: "Initial", body: "Closes #41" });
    const request = await planGitHubWorkflow(f.root, input("ready_pr", { issue: 41, branch: "codex/41-workflow", headSha: f.headSha, prNumber: 51 }));
    f.client.readyPull.mockImplementation(async () => {
      Object.assign(f.state.pull, { draft: false, body: "Unapproved concurrent change" });
      return { nodeId: "PR_51", draft: false };
    });
    await expect(runGitHubWorkflow(f.root, request)).rejects.toThrow(/inspect provider state/i);
    expect(f.client.readyPull).toHaveBeenCalledTimes(1);
  });

  it("keeps readiness bound to planned content even if its first final read observes drift", async () => {
    const f = await fixture();
    f.state.remoteHead = f.headSha;
    await f.client.createPull("fixture-user/app", { branch: "codex/41-workflow", title: "Initial", body: "Closes #41" });
    const request = await planGitHubWorkflow(f.root, input("ready_pr", { issue: 41, branch: "codex/41-workflow", headSha: f.headSha, prNumber: 51 }));
    let reads = 0;
    f.client.pull.mockImplementation(async () => {
      reads += 1;
      if (reads === 3) f.state.pull.body = "Closes #41\nUnapproved replacement";
      return structuredClone(f.state.pull);
    });
    await expect(runGitHubWorkflow(f.root, request)).rejects.toThrow(/inspect provider state/i);
    expect(f.client.readyPull).not.toHaveBeenCalled();
  });

  it("never retries an ambiguous mutation and records post-state failures", async () => {
    const f = await fixture();
    f.client.createIssue.mockRejectedValue(new Error("SECRET_TOKEN network timeout"));
    const proposal = input("create_issue", { title: "Approved", body: "AC-1" });
    await expect(runGitHubWorkflow(f.root, await planGitHubWorkflow(f.root, proposal))).rejects.toThrow(/inspect provider state/i);
    await expect(runGitHubWorkflow(f.root, await planGitHubWorkflow(f.root, proposal))).rejects.toThrow();
    expect(f.client.createIssue).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong Issue branch, closed Issue and PR linkage", async () => {
    const f = await fixture();
    const scope = { issue: 41, branch: "codex/41-workflow", headSha: f.headSha };
    await expect(planGitHubWorkflow(f.root, input("push_branch", { ...scope, issue: 42, expectedHeadSha: null }))).rejects.toThrow(/Issue/i);
    f.state.issue.state = "CLOSED";
    await expect(planGitHubWorkflow(f.root, input("push_branch", { ...scope, expectedHeadSha: null }))).rejects.toThrow(/open/i);
    f.state.issue.state = "OPEN";
    f.state.remoteHead = f.headSha;
    await expect(planGitHubWorkflow(f.root, input("create_pr", { ...scope, title: "Title", body: "Closes #410" }))).rejects.toThrow(/exact Issue/i);
    f.client.findPull.mockResolvedValue({ items: [], complete: false });
    await expect(planGitHubWorkflow(f.root, input("create_pr", { ...scope, title: "Title", body: "Closes #41" }))).rejects.toThrow(/Incomplete/i);
  });

  it("updates exact PR content and requires authoritative reviews before ready", async () => {
    const f = await fixture();
    f.state.remoteHead = f.headSha;
    await f.client.createPull("fixture-user/app", { branch: "codex/41-workflow", title: "Initial", body: "Closes #41" });
    const scope = { issue: 41, branch: "codex/41-workflow", headSha: f.headSha, prNumber: 51 };
    const update = await planGitHubWorkflow(f.root, input("update_pr", { ...scope, title: "Reviewed", body: "Closes #41\n\nReview evidence", expectedContentDigest: workflowContentDigest(f.state.pull) }));
    expect(await runGitHubWorkflow(f.root, update)).toMatchObject({ title: "Reviewed", draft: true });
    const ready = await planGitHubWorkflow(f.root, input("ready_pr", scope));
    mocks.gate.mockRejectedValueOnce(new Error("Missing exact Head review"));
    await expect(runGitHubWorkflow(f.root, ready)).rejects.toThrow(/Missing exact Head/i);
    expect(f.client.readyPull).not.toHaveBeenCalled();
    mocks.gate.mockResolvedValue({ ok: true });
    expect(await runGitHubWorkflow(f.root, ready)).toMatchObject({ draft: false });
    expect(mocks.gate).toHaveBeenCalledWith(f.root, 41);
  });

  it("binds draft content at planning and rejects cross-repository PRs", async () => {
    const f = await fixture();
    f.state.remoteHead = f.headSha;
    await f.client.createPull("fixture-user/app", { branch: "codex/41-workflow", title: "Initial", body: "Closes #41" });
    const scope = { issue: 41, branch: "codex/41-workflow", headSha: f.headSha, prNumber: 51 };
    const ready = await planGitHubWorkflow(f.root, input("ready_pr", scope));
    f.state.pull.body = "Unapproved replacement";
    await expect(runGitHubWorkflow(f.root, ready)).rejects.toThrow(/contract changed/i);
    f.state.pull.headRepositoryId = 999;
    await expect(planGitHubWorkflow(f.root, input("ready_pr", scope))).rejects.toThrow(/repository/i);
    expect(f.client.claim).not.toHaveBeenCalled();
  });

  it("supports Claude equally and rejects a symlink journal", async () => {
    const f = await fixture();
    git(f.root, ["switch", "-c", "claude/41-workflow"]);
    const request = await planGitHubWorkflow(f.root, input("push_branch", { issue: 41, branch: "claude/41-workflow", headSha: f.headSha, expectedHeadSha: null }, { operatorLabel: "claude", executionSurface: "claude-local" }));
    await runGitHubWorkflow(f.root, request);
    expect(f.client.push).toHaveBeenCalledTimes(1);
    const other = await fixture();
    const target = await mkdtemp(path.join(os.tmpdir(), "workflow-symlink-"));
    await symlink(target, path.join(other.root, ".git/github-workflow-v1"), "junction");
    await expect(planGitHubWorkflow(other.root, input("list_issues", {}))).rejects.toThrow(/symlink/i);
  });
});
