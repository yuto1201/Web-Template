import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { authorizeServiceUse, evaluateAccountObservation } from "./authority-core.mjs";
import { digestValue, loadProtectedAuthority, runAuthoritativePremergeGate } from "./workflow-core.mjs";
import { createGitHubWorkflowClient } from "./github-workflow-client.mjs";

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const number = z.number().int().positive();
const text = z.string().trim().min(1).max(60000).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value), "Control characters are not permitted");
const title = text.max(256).refine((value) => !/[\r\n]/u.test(value));
const branch = z.string().regex(/^(codex|claude)\/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const scoped = { issue: number, branch, headSha: sha };
const content = { title, body: text };
const operationNames = ["list_issues", "read_issue", "create_issue", "push_branch", "read_pr", "create_pr", "update_pr", "ready_pr", "read_checks"];
const commonSchema = z.object({
  schemaVersion: z.literal(1),
  operatorLabel: z.enum(["codex", "claude"]),
  executionRole: z.enum(["implementer", "external-operator"]),
  executionSurface: z.enum(["codex-local", "claude-local"]),
  purpose: title,
  approvalReference: title,
}).strict();
const operationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list_issues"), inputs: z.object({}).strict() }),
  z.object({ operation: z.literal("read_issue"), inputs: z.object({ issue: number }).strict() }),
  z.object({ operation: z.literal("create_issue"), inputs: z.object(content).strict() }),
  z.object({ operation: z.literal("push_branch"), inputs: z.object({ ...scoped, expectedHeadSha: sha.nullable() }).strict() }),
  z.object({ operation: z.literal("read_pr"), inputs: z.object({ prNumber: number }).strict() }),
  z.object({ operation: z.literal("create_pr"), inputs: z.object({ ...scoped, ...content }).strict() }),
  z.object({ operation: z.literal("update_pr"), inputs: z.object({ ...scoped, ...content, prNumber: number, expectedContentDigest: digest }).strict() }),
  z.object({ operation: z.literal("ready_pr"), inputs: z.object({ ...scoped, prNumber: number }).strict() }),
  z.object({ operation: z.literal("read_checks"), inputs: z.object({ headSha: sha }).strict() }),
]);
// The two halves are parsed independently below so unknown top-level keys still fail closed.
const commonKeys = ["schemaVersion", "operatorLabel", "executionRole", "executionSurface", "purpose", "approvalReference"];
const policySchema = z.object({ schemaVersion: z.literal(1), operations: z.array(z.string().refine((value) => operationNames.includes(value))).min(1), requestTtlSeconds: z.number().int().min(60).max(900), claimNamespace: z.literal("refs/notes/github-workflow/") }).strict();
const requestSchema = z.object({
  schemaVersion: z.literal(1), requestId: z.uuid(), intent: z.unknown(),
  mainSha: sha, authorityDigest: digest, policyDigest: digest,
  bindingDigest: digest.nullable(), issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
}).strict();

/** @typedef {z.infer<typeof commonSchema> & z.infer<typeof operationSchema>} Intent */
/** @typedef {z.infer<typeof requestSchema> & {intent: Intent}} Request */
/** @typedef {Awaited<ReturnType<typeof createGitHubWorkflowClient>>} Client */
/** @param {unknown} value @returns {Intent} */
function parseIntent(value) {
  const raw = z.record(z.string(), z.unknown()).parse(value);
  if (Object.keys(raw).some((key) => ![...commonKeys, "operation", "inputs"].includes(key))) throw new Error("Unknown workflow input key.");
  const base = commonSchema.parse(Object.fromEntries(commonKeys.map((key) => [key, raw[key]])));
  const operation = operationSchema.parse({ operation: raw.operation, inputs: raw.inputs });
  if (base.executionSurface !== `${base.operatorLabel}-local`) throw new Error("Operator and execution surface mismatch.");
  return { ...base, ...operation };
}

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error("Cannot read required local Git state.");
  return result.stdout.trim();
}

/** @param {string} root @param {Intent} intent */
function protectedContext(root, intent) {
  const trusted = loadProtectedAuthority(root, "main");
  let policy;
  try { policy = policySchema.parse(JSON.parse(git(root, ["show", `${trusted.commitSha}:config/github-workflow.json`]))); }
  catch { throw new Error("Protected main workflow policy is absent or invalid; candidate policy cannot authorize this operation."); }
  if (!policy.operations.includes(intent.operation)) throw new Error("Operation is not enabled by protected policy.");
  if (!trusted.authority.authorization.operatorLabels.includes(intent.operatorLabel) || !trusted.authority.authorization.externalOperatorRoles.includes(intent.executionRole)) throw new Error("Execution role is not authorized.");
  authorizeServiceUse(trusted.authority, { service: "github", operation: intent.operation, purposeCode: "repository-workflow", explicitUserPurpose: null });
  const target = trusted.authority.resourceTargets.github;
  return { ...trusted, policy, policyDigest: digestValue(policy), repository: `${target.owner}/${target.repository}` };
}

/** @param {Client} client @param {ReturnType<typeof protectedContext>} context */
async function observe(client, context) {
  const actual = await client.observe(context.repository);
  const identity = evaluateAccountObservation(context.authority, { service: "github", account: actual.account, target: actual.target });
  if (actual.mainSha !== context.commitSha) throw new Error("Protected main differs from live GitHub main; refresh before planning.");
  return identity;
}

/** @param {{title:string,body:string}} value */
export function workflowContentDigest(value) { return digestValue({ title: value.title, body: value.body }); }

/** @param {string} root */
async function journal(root) {
  const common = await realpath(path.resolve(root, git(root, ["rev-parse", "--git-common-dir"])));
  let current = common;
  for (const segment of ["github-workflow-v1"]) {
    current = path.join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Workflow journal must not be a symlink.");
  }
  return current;
}

/** @param {string} file @param {unknown} value */
async function immutable(file, value) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

/** @param {string} file */
async function readImmutable(file) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 160000) throw new Error("Invalid workflow journal record.");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

/** @param {Intent} intent */
function isWrite(intent) { return ["create_issue", "push_branch", "create_pr", "update_pr", "ready_pr"].includes(intent.operation); }

/** @param {string} root @param {Client} client @param {ReturnType<typeof protectedContext>} context @param {Intent} intent */
async function conditions(root, client, context, intent) {
  if (intent.operation !== "push_branch" && intent.operation !== "create_pr" && intent.operation !== "update_pr" && intent.operation !== "ready_pr") return null;
  const inputs = intent.inputs;
  if (!inputs.branch.startsWith(`${intent.operatorLabel}/${inputs.issue}-`)) throw new Error("Branch does not match the Issue and execution surface.");
  if (git(root, ["branch", "--show-current"]) !== inputs.branch || git(root, ["rev-parse", "HEAD"]) !== inputs.headSha) throw new Error("Local branch or Head changed.");
  if (git(root, ["status", "--porcelain", "--untracked-files=no"])) throw new Error("Tracked worktree changes must be committed before a write.");
  const issue = await client.issue(context.repository, inputs.issue);
  if (issue.number !== inputs.issue || issue.state !== "OPEN") throw new Error("Expected an open real Issue.");
  const issueDigest = digestValue({ number: issue.number, title: issue.title, body: issue.body, state: issue.state });
  const remote = await client.branch(context.repository, inputs.branch);
  if (intent.operation === "push_branch") {
    if (remote !== intent.inputs.expectedHeadSha) throw new Error("Remote branch no longer matches the expected prior Head.");
    if (remote === inputs.headSha) throw new Error("Branch already has this Head; inspect instead of replaying a push.");
  } else if (remote !== inputs.headSha) throw new Error("Remote PR branch Head mismatch.");
  if ("body" in inputs && !new RegExp(`(?:^|\\n)Closes #${inputs.issue}\\s*(?:\\n|$)`, "u").test(inputs.body)) throw new Error("PR body must close the exact Issue on its own line.");
  if (intent.operation === "create_pr") {
    const found = await client.findPull(context.repository, inputs.branch);
    if (!found.complete) throw new Error("Incomplete PR lookup; inspect before creating.");
    if (found.items.length) throw new Error("An open PR already exists; read or update it instead.");
  }
  let pullDigest = null;
  if ("prNumber" in inputs) {
    const pull = await client.pull(context.repository, inputs.prNumber);
    assertPull(pull, context, inputs);
    if (intent.operation === "update_pr" && workflowContentDigest(pull) !== intent.inputs.expectedContentDigest) throw new Error("PR content changed after approval.");
    if (intent.operation === "ready_pr" && !pull.draft) throw new Error("PR is already ready; inspect instead of replaying.");
    pullDigest = digestValue(pull);
  }
  return digestValue({ issueDigest, pullDigest });
}

/** @param {Awaited<ReturnType<Client['pull']>>} pull @param {ReturnType<typeof protectedContext>} context @param {{branch:string,headSha:string,prNumber?:number}} inputs */
function assertPull(pull, context, inputs) {
  if (pull.state !== "OPEN" || pull.baseBranch !== "main" || pull.branch !== inputs.branch || pull.headSha !== inputs.headSha || pull.headRepositoryId !== context.authority.resourceTargets.github.repositoryId || (inputs.prNumber !== undefined && pull.number !== inputs.prNumber)) throw new Error("PR repository, branch, state or Head mismatch.");
}

/** Plan is an explicit user-purpose attestation, not proof of a chat message or OS isolation.
 * @param {string} root @param {unknown} value */
export async function planGitHubWorkflow(root, value) {
  const intent = parseIntent(value);
  const context = protectedContext(root, intent); // No credentials until protected policy authorizes the shape.
  const client = await createGitHubWorkflowClient();
  const identity = await observe(client, context);
  const bindingDigest = await conditions(root, client, context, intent);
  const issuedAt = new Date();
  const request = { schemaVersion: /** @type {const} */ (1), requestId: randomUUID(), intent, mainSha: context.commitSha, authorityDigest: context.digest, policyDigest: context.policyDigest, bindingDigest, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + context.policy.requestTtlSeconds * 1000).toISOString() };
  const directory = await journal(root);
  await immutable(path.join(directory, `request-${request.requestId}.json`), request);
  await immutable(path.join(directory, `preflight-${request.requestId}.json`), { requestId: request.requestId, requestDigest: digestValue(request), ...identity, issuedAt: request.issuedAt });
  return request;
}

/** Deliberately exclude operator, request UUID, main and time: none can reset one-use semantics.
 * @param {ReturnType<typeof protectedContext>} context @param {Intent} intent */
function semanticDigest(context, intent) {
  const inputs = intent.operation === "create_pr" ? { issue: intent.inputs.issue, branch: intent.inputs.branch, base: "main" } : intent.inputs;
  return digestValue({ repositoryId: context.authority.resourceTargets.github.repositoryId, operation: intent.operation, inputs });
}

/** @param {string} root @param {Request} request */
function currentContext(root, request) {
  const context = protectedContext(root, request.intent);
  if (context.commitSha !== request.mainSha || context.digest !== request.authorityDigest || context.policyDigest !== request.policyDigest) throw new Error("Protected policy or authority changed; request is stale.");
  const now = Date.now();
  const duration = Date.parse(request.expiresAt) - Date.parse(request.issuedAt);
  if (Date.parse(request.issuedAt) > now || Date.parse(request.expiresAt) <= now || duration !== context.policy.requestTtlSeconds * 1000) throw new Error("Workflow request expired or has an invalid lifetime.");
  return context;
}

/** @param {string} root @param {unknown} value */
export async function runGitHubWorkflow(root, value) {
  const parsed = requestSchema.parse(value);
  const request = { ...parsed, intent: parseIntent(parsed.intent) };
  const context = currentContext(root, request);
  const directory = await journal(root);
  const saved = await readImmutable(path.join(directory, `request-${request.requestId}.json`));
  const preflight = await readImmutable(path.join(directory, `preflight-${request.requestId}.json`));
  if (digestValue(saved) !== digestValue(request) || preflight.requestDigest !== digestValue(request)) throw new Error("Request differs from the immutable approved plan.");
  const client = await createGitHubWorkflowClient();
  await observe(client, context);
  if (await conditions(root, client, context, request.intent) !== request.bindingDigest) throw new Error("Issue or PR contract changed after planning.");
  if (request.intent.operation === "ready_pr") await runAuthoritativePremergeGate(root, request.intent.inputs.issue);
  const semantic = semanticDigest(context, request.intent);
  const attemptId = randomUUID();
  let claimed = false;
  try {
    if (isWrite(request.intent)) {
      // Atomic local create protects worktrees; provider create-only ref also protects independent clones.
      try { await immutable(path.join(directory, `claim-${semantic.slice(7)}.json`), { requestId: request.requestId, attemptId, semantic, createdAt: new Date().toISOString() }); }
      catch { throw new Error("Operation is already claimed or journal is unsafe; inspect only, do not retry."); }
      claimed = true;
      const ref = `${context.policy.claimNamespace}${semantic.slice(7)}`;
      const remoteClaim = await client.claim(context.repository, ref, context.commitSha);
      if (remoteClaim.ref !== ref || remoteClaim.sha !== context.commitSha) throw new Error("Provider claim was not confirmed.");
      currentContext(root, request);
      await observe(client, context);
      if (await conditions(root, client, context, request.intent) !== request.bindingDigest) throw new Error("Issue or PR changed before execution.");
    }
    const result = await execute(root, client, context, request.intent);
    await observe(client, context);
    await immutable(path.join(directory, `result-${attemptId}.json`), { requestId: request.requestId, operation: request.intent.operation, semantic, status: "observed", resultDigest: digestValue(result), finishedAt: new Date().toISOString() });
    return result;
  } catch (error) {
    await immutable(path.join(directory, `result-${attemptId}.json`), { requestId: request.requestId, operation: request.intent.operation, semantic, status: claimed ? "ambiguous-inspect-only" : "rejected", errorDigest: digestValue(String(error)), finishedAt: new Date().toISOString() }).catch(() => {});
    throw new Error(claimed ? "Claimed operation did not finalize; inspect provider state, never automatically retry." : "Workflow operation rejected; no execution claim acquired.");
  }
}

/** @param {string} root @param {Client} client @param {ReturnType<typeof protectedContext>} context @param {Intent} intent */
async function execute(root, client, context, intent) {
  const repository = context.repository;
  switch (intent.operation) {
    case "list_issues": return client.listIssues(repository);
    case "read_issue": return client.issue(repository, intent.inputs.issue);
    case "read_pr": return client.pull(repository, intent.inputs.prNumber);
    case "read_checks": return client.checks(repository, intent.inputs.headSha);
    case "create_issue": {
      const created = await client.createIssue(repository, intent.inputs);
      const observed = await client.issue(repository, created.number);
      if (created.number !== observed.number || observed.state !== "OPEN" || workflowContentDigest(observed) !== workflowContentDigest(intent.inputs)) throw new Error("Issue post-state mismatch.");
      return observed;
    }
    case "push_branch": {
      await client.push({ root, repository, branch: intent.inputs.branch, expectedHeadSha: intent.inputs.expectedHeadSha, headSha: intent.inputs.headSha });
      if (await client.branch(repository, intent.inputs.branch) !== intent.inputs.headSha) throw new Error("Push post-state mismatch.");
      return { branch: intent.inputs.branch, headSha: intent.inputs.headSha };
    }
    case "create_pr":
    case "update_pr": {
      const created = intent.operation === "create_pr" ? await client.createPull(repository, { branch: intent.inputs.branch, title: intent.inputs.title, body: intent.inputs.body }) : await client.updatePull(repository, intent.inputs.prNumber, { title: intent.inputs.title, body: intent.inputs.body });
      const observed = await client.pull(repository, created.number);
      assertPull(observed, context, { ...intent.inputs, prNumber: created.number });
      if (workflowContentDigest(observed) !== workflowContentDigest(intent.inputs) || (intent.operation === "create_pr" && !observed.draft)) throw new Error("PR post-state mismatch.");
      return observed;
    }
    case "ready_pr": {
      const pull = await client.pull(repository, intent.inputs.prNumber);
      assertPull(pull, context, intent.inputs);
      await runAuthoritativePremergeGate(root, intent.inputs.issue);
      if (git(root, ["rev-parse", "HEAD"]) !== intent.inputs.headSha) throw new Error("Head changed during authoritative review gate.");
      const fresh = await client.pull(repository, intent.inputs.prNumber);
      assertPull(fresh, context, intent.inputs);
      if (fresh.nodeId !== pull.nodeId || workflowContentDigest(fresh) !== workflowContentDigest(pull)) throw new Error("PR changed during authoritative review gate.");
      await client.readyPull(repository, fresh.nodeId);
      const observed = await client.pull(repository, intent.inputs.prNumber);
      assertPull(observed, context, intent.inputs);
      if (observed.draft) throw new Error("Ready post-state mismatch.");
      return observed;
    }
  }
}
