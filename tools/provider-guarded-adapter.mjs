import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  claimOperationExecution,
  createOperationReceiptState,
  digestValue,
  readExternalOperationRequest,
  validateOperationResult,
  validatePreflightReceipt,
} from "./workflow-core.mjs";
import {
  evaluateAccountObservation,
  normalizeProviderObservation,
  parseAuthority,
} from "./authority-core.mjs";

const readOnlyOperations = new Set([
  "github.read_issue",
  "supabase.inspect_project",
  "vercel.inspect_project",
  "cloudflare.inspect_zone",
]);

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr ?? "").trim()}`);
  }
  return result.stdout.trim();
}

/** @param {string} root @param {string} commitSha */
function authorityAt(root, commitSha) {
  return parseAuthority(JSON.parse(git(root, ["show", `${commitSha}:config/ownership.json`])));
}

/** @param {string} root */
async function sharedStateDirectory(root) {
  const common = path.resolve(root, git(root, ["rev-parse", "--git-common-dir"]));
  const canonicalCommon = await realpath(common);
  const directory = path.join(canonicalCommon, "account-bound-authority", "operation-claims");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(path.dirname(directory), 0o700);
  await chmod(directory, 0o700);
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Shared operation-claim state must be a real directory.");
  if (typeof process.getuid !== "function" || stats.uid !== process.getuid() || (stats.mode & 0o777) !== 0o700) {
    throw new Error("Shared operation-claim state must be current-user owned with mode 700.");
  }
  return directory;
}

/** @param {string} root @param {string} key @param {unknown} value */
async function claimWriteOnce(root, key, value) {
  const directory = await sharedStateDirectory(root);
  const digest = /^sha256:([0-9a-f]{64})$/u.exec(key)?.[1];
  if (!digest) throw new Error("Operation idempotency digest is invalid.");
  const filePath = path.join(directory, `${digest}.claim.json`);
  let handle;
  try {
    handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("The same mutation is already claimed or terminal in this repository.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return path.relative(root, filePath).replaceAll("\\", "/");
}

/** @param {string} operation @param {Record<string, any>} request @param {unknown} observationValue */
export function validateLiveOperationObservation(operation, request, observationValue) {
  if (!observationValue || typeof observationValue !== "object" || Array.isArray(observationValue)) {
    throw new Error("Provider operation observation is required.");
  }
  const observation = /** @type {Record<string, any>} */ (observationValue);
  /** @type {Record<string, string[]>} */
  const liveBindings = {
    "github.push_branch": ["repository", "branch", "headSha"],
    "github.create_pr": ["repository", "branch", "baseBranch", "headSha"],
    "github.merge_pr": ["repository", "prNumber", "headSha", "method"],
    "github.delete_branch": ["repository", "branch", "mergedPrNumber", "headSha"],
    "supabase.apply_migrations": ["projectRef", "migrations"],
    "vercel.deploy_preview": ["projectId", "environment", "headSha", "configuration"],
    "vercel.deploy_production": ["projectId", "environment", "headSha", "configuration"],
    "cloudflare.upsert_dns": ["zoneId", "hostname", "recordType", "target", "proxied", "routingSource"],
  };
  for (const key of liveBindings[operation] ?? []) {
    if (digestValue(observation[key]) !== digestValue(request.inputs[key])) {
      const label = key === "headSha" ? "Head" : key === "migrations" ? "migration content digest" : key;
      throw new Error(`Live ${label} does not match the frozen mutation immediately before execution.`);
    }
  }
  if (operation.startsWith("github.") && observation.repository !== request.resolvedTarget) {
    throw new Error("Live GitHub repository does not match the frozen target.");
  }
  return structuredClone(observation);
}

/** @param {Record<string, any>} authority */
function repositoryStableIdentity(authority) {
  const target = authority.resourceTargets.github;
  return `github:${target.repositoryId}:${target.repositoryNodeId}`;
}

/** @param {unknown} value */
function date(value) {
  const result = value instanceof Date ? value : new Date(/** @type {any} */ (value));
  if (!Number.isFinite(result.getTime())) throw new Error("Guarded adapter clock returned an invalid Date.");
  return result;
}

/**
 * @param {{ service: "github" | "supabase" | "vercel" | "cloudflare", providerClient: Record<string, any>, clock?: () => Date }} configuration
 */
export function executeGuardedProviderOperation(configuration) {
  const { service, providerClient } = configuration;
  const clock = configuration.clock ?? (() => new Date());
  if (providerClient?.service !== service || typeof providerClient.surface !== "string") {
    throw new Error(`The ${service} guarded adapter requires a provider-specific client and fixed surface.`);
  }
  for (const method of ["collectObservation", "execute", "idempotencyMode"]) {
    if (typeof providerClient[method] !== "function") throw new Error(`Provider client is missing ${method}().`);
  }

  return {
    /** @param {{root: string, requestPath: string}} input */
    async execute(input) {
      const loaded = await readExternalOperationRequest(input.root, input.requestPath);
      const request = loaded.request;
      if (request.authorization.service !== service) throw new Error("Guarded adapter service mismatch.");
      if (!request.operation.startsWith(`${service}.`)) throw new Error("Guarded adapter operation does not belong to its provider.");
      if (request.executionSurface !== providerClient.surface) throw new Error("Operation request surface does not match the provider adapter surface.");
      const rawRequest = JSON.parse(await readFile(path.resolve(input.root, input.requestPath), "utf8"));
      const contract = JSON.parse(await readFile(path.join(input.root, ".artifacts", "issues", String(request.issue), "issue-contract.json"), "utf8"));
      const authority = authorityAt(input.root, contract.authority.commitSha);
      const isWrite = !readOnlyOperations.has(request.operation);
      if (isWrite && providerClient.idempotencyMode(request.operation) !== "provider-enforced") {
        throw new Error(`Execution denied: ${request.operation} lacks provider-enforced idempotency across clones.`);
      }

      const receiptState = createOperationReceiptState();
      const firstRaw = await providerClient.collectObservation({ phase: "preflight", request: structuredClone(request) });
      const first = normalizeProviderObservation(authority, { service, account: firstRaw.account, target: firstRaw.target });
      validateLiveOperationObservation(request.operation, request, firstRaw.operation);
      const observedAt = date(clock());
      const receipt = {
        schemaVersion: 1,
        receiptId: `receipt-${service}-${randomUUID()}`,
        requestId: request.requestId,
        service,
        operatorLabel: request.operatorLabel,
        executionRole: request.executionRole,
        executionSurface: providerClient.surface,
        authorityDigest: contract.authority.digest,
        issueContractDigest: contract.digest,
        authorizationDigest: digestValue(request.authorization),
        requestDigest: digestValue(rawRequest),
        mutationDigest: digestValue({ operation: request.operation, inputs: request.inputs }),
        accountObservation: first.account,
        targetObservation: first.target,
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(observedAt.getTime() + 120_000).toISOString(),
      };
      const validatedPreflight = validatePreflightReceipt(receipt, {
        root: input.root,
        contract,
        request: rawRequest,
        executionSurface: providerClient.surface,
        now: observedAt.toISOString(),
        receiptState,
      });

      const secondRaw = await providerClient.collectObservation({ phase: "claim", request: structuredClone(request) });
      const second = normalizeProviderObservation(authority, { service, account: secondRaw.account, target: secondRaw.target });
      evaluateAccountObservation(authority, {
        service,
        account: second.account,
        target: second.target,
        previousAccount: first.account,
        previousTarget: first.target,
      });
      const secondOperation = validateLiveOperationObservation(request.operation, request, secondRaw.operation);
      const claimObservationDigest = digestValue({ account: second.account, target: second.target, operation: secondOperation });
      const claimTime = date(clock()).toISOString();
      const baseClaim = claimOperationExecution(receipt.receiptId, { receiptState, now: claimTime });
      const idempotencyDigest = digestValue({
        repositoryIdentity: repositoryStableIdentity(authority),
        authorityDigest: contract.authority.digest,
        authorizationDigest: validatedPreflight.authorizationDigest,
        requestDigest: validatedPreflight.requestDigest,
        mutationDigest: validatedPreflight.mutationDigest,
      });
      const idempotencyKey = `authority-${idempotencyDigest.slice("sha256:".length)}`;
      const claim = { ...baseClaim, observationDigest: claimObservationDigest, idempotencyKeyDigest: digestValue(idempotencyKey) };
      let claimReference = null;
      if (isWrite) claimReference = await claimWriteOnce(input.root, idempotencyDigest, claim);

      const providerResult = await providerClient.execute({
        request: structuredClone(request),
        operation: request.operation,
        inputs: structuredClone(request.inputs),
        idempotencyKey,
      });
      const postRaw = await providerClient.collectObservation({ phase: "postflight", request: structuredClone(request) });
      const post = normalizeProviderObservation(authority, { service, account: postRaw.account, target: postRaw.target });
      evaluateAccountObservation(authority, {
        service,
        account: post.account,
        target: post.target,
        previousAccount: second.account,
        previousTarget: second.target,
      });
      validateLiveOperationObservation(request.operation, request, postRaw.operation);
      const postObservedAt = date(clock());
      const outcome = {
        status: providerResult.status,
        evidence: providerResult.evidence,
        evidenceDigest: digestValue(providerResult.evidence),
        ...(providerResult.status === "succeeded" ? {} : { retryPolicy: providerResult.retryPolicy }),
      };
      const resultReceipt = {
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
          accountObservation: first.account,
          targetObservation: first.target,
          observedAt: receipt.observedAt,
        },
        postflight: {
          accountObservation: post.account,
          targetObservation: post.target,
          observedAt: postObservedAt.toISOString(),
        },
        outcome,
      };
      const validatedResult = validateOperationResult(resultReceipt, {
        root: input.root,
        contract,
        request: rawRequest,
        executionSurface: providerClient.surface,
        now: date(clock()).toISOString(),
        receiptState,
      });
      return {
        ok: true,
        service,
        operation: request.operation,
        outcome: validatedResult.outcome,
        lifecycle: {
          request: { digest: validatedPreflight.requestDigest },
          preflight: { receiptId: receipt.receiptId, digest: digestValue(receipt) },
          claim: { reference: claimReference, digest: digestValue(claim), observationDigest: claimObservationDigest },
          mutation: { digest: validatedPreflight.mutationDigest, idempotencyKeyDigest: digestValue(idempotencyKey) },
          result: { receiptId: receipt.receiptId, digest: digestValue(resultReceipt) },
          finalized: { digest: digestValue(validatedResult) },
        },
        warnings: validatedResult.warnings,
      };
    },
  };
}

/** @param {{providerClient: Record<string, any>, clock?: () => Date}} configuration */
export const createGitHubGuardedAdapter = (configuration) => executeGuardedProviderOperation({ service: "github", ...configuration });
/** @param {{providerClient: Record<string, any>, clock?: () => Date}} configuration */
export const createSupabaseGuardedAdapter = (configuration) => executeGuardedProviderOperation({ service: "supabase", ...configuration });
/** @param {{providerClient: Record<string, any>, clock?: () => Date}} configuration */
export const createVercelGuardedAdapter = (configuration) => executeGuardedProviderOperation({ service: "vercel", ...configuration });
/** @param {{providerClient: Record<string, any>, clock?: () => Date}} configuration */
export const createCloudflareGuardedAdapter = (configuration) => executeGuardedProviderOperation({ service: "cloudflare", ...configuration });
