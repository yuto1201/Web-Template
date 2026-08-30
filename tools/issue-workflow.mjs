import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindExternalOperationEvidence,
  collectAndValidateCleanupPlan,
  claimOperationExecution,
  createOperationReceiptState,
  createMergeOperationRequest,
  digestValue,
  loadProtectedAuthority,
  prepareReviewArtifacts,
  readExternalOperationRequest,
  recordReviewResult,
  renderAuthoritativePullRequestBody,
  resolveInside,
  runAuthoritativePremergeGate,
  simulateWorkflowFixture,
  snapshotIssueContract,
  transitionPersistedWorkflowState,
  validateOperationResult,
  validatePreflightReceipt,
} from "./workflow-core.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");

/** @param {string} filePath */
async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

/** @param {string} filePath @param {unknown} value */
async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** @param {string[]} args */
function parseOptions(args) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Expected --name value, received ${args.slice(index).join(" ")}.`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

/** @param {Record<string, string>} options @param {string} name */
function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

/** @param {Record<string, string>} options @param {string} name */
function positiveInteger(options, name) {
  const value = Number(required(options, name));
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer.`);
  return value;
}

/** @param {unknown} value */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** @param {unknown} error @param {string} code */
function hasErrorCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

/** @param {import("node:fs").Stats} stats @param {string} label */
function assertCurrentOwner(stats, label) {
  if (typeof process.getuid !== "function") {
    throw new Error("Secure receipt-state ownership verification is unavailable on this platform; external mutation commands fail closed.");
  }
  if (stats.uid !== process.getuid()) throw new Error(`${label} must be owned by the current operating-system user.`);
}

/** @param {import("node:fs").Stats} stats @param {string} label @param {number} mode */
function assertOwnerOnlyMode(stats, label, mode) {
  if ((stats.mode & 0o777) !== mode) {
    throw new Error(`${label} must use owner-only mode ${mode.toString(8)}.`);
  }
}

/** @param {import("node:fs").Stats} left @param {import("node:fs").Stats} right */
function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** @param {{ directoryPath: string, realPath: string, stats: import("node:fs").Stats, handle: import("node:fs/promises").FileHandle }} snapshot */
async function assertReceiptDirectoryContinuity(snapshot) {
  const pathStats = await lstat(snapshot.directoryPath);
  if (pathStats.isSymbolicLink() || !pathStats.isDirectory()) {
    throw new Error("Receipt-state parent path identity changed during use.");
  }
  assertCurrentOwner(pathStats, "Receipt-state parent directory");
  assertOwnerOnlyMode(pathStats, "Receipt-state parent directory", 0o700);
  const descriptorStats = await snapshot.handle.stat();
  if (
    !descriptorStats.isDirectory() ||
    !sameFileIdentity(snapshot.stats, pathStats) ||
    !sameFileIdentity(snapshot.stats, descriptorStats) ||
    await realpath(snapshot.directoryPath) !== snapshot.realPath
  ) {
    throw new Error("Receipt-state parent device, inode, or realpath changed during use.");
  }
}

/**
 * Holds a directory descriptor and compares it with path metadata before and after opening the
 * final component. Node does not expose openat(2), so this detects path replacement but does not
 * claim cryptographic isolation from arbitrary filesystem mutation by the same OS user.
 * @param {string} root @param {"receipts" | "mutations"} kind
 */
async function openSecureReceiptStateDirectory(root, kind) {
  const canonicalRoot = await realpath(root);
  const rootStats = await lstat(canonicalRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("Receipt-state repository root must be a real directory.");
  assertCurrentOwner(rootStats, "Receipt-state repository root");
  let current = canonicalRoot;
  const segments = [".artifacts", "ops-receipts", kind];
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!hasErrorCode(mkdirError, "EEXIST")) throw mkdirError;
      }
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink()) throw new Error("Receipt-state parent directories must not be symbolic links.");
    if (!entry.isDirectory()) throw new Error("Receipt-state parent path must be a directory.");
    assertCurrentOwner(entry, "Receipt-state parent directory");
    if (index > 0) assertOwnerOnlyMode(entry, "Receipt-state parent directory", 0o700);
    if (await realpath(current) !== current) throw new Error("Receipt-state parent directory resolved outside its canonical path.");
  }
  if (constants.O_DIRECTORY === undefined || constants.O_NOFOLLOW === undefined) {
    throw new Error("Secure receipt-state directory descriptors are unavailable on this platform; external mutation commands fail closed.");
  }
  const handle = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    const snapshot = { directoryPath: current, realPath: await realpath(current), stats, handle };
    assertCurrentOwner(stats, "Receipt-state parent directory");
    assertOwnerOnlyMode(stats, "Receipt-state parent directory", 0o700);
    await assertReceiptDirectoryContinuity(snapshot);
    return snapshot;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** @param {string} receiptId */
function validatedReceiptStateFileName(receiptId) {
  if (!/^receipt-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(receiptId)) throw new Error("Receipt ID is not a canonical state key.");
  return `${receiptId}.validated.json`;
}

/** @param {string} mutationDigest @param {"claim" | "finalized"} phase */
function mutationStateFileName(mutationDigest, phase) {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(mutationDigest);
  if (!match) throw new Error("Mutation digest is not a canonical state key.");
  return `${match[1]}.${phase}.json`;
}

/** @param {{ directoryPath: string, realPath: string, stats: import("node:fs").Stats, handle: import("node:fs/promises").FileHandle }} directory @param {string} fileName @param {import("node:fs/promises").FileHandle} handle */
async function assertReceiptStateFileContinuity(directory, fileName, handle) {
  const filePath = path.join(directory.directoryPath, fileName);
  const descriptorStats = await handle.stat();
  const pathStats = await lstat(filePath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile() || !descriptorStats.isFile()) {
    throw new Error("Receipt-state path must be a regular file and must not be a symbolic link.");
  }
  assertCurrentOwner(descriptorStats, "Receipt-state file");
  assertOwnerOnlyMode(descriptorStats, "Receipt-state file", 0o600);
  if (!sameFileIdentity(descriptorStats, pathStats)) throw new Error("Receipt-state file device or inode changed during use.");
  const fileRealPath = await realpath(filePath);
  if (path.dirname(fileRealPath) !== directory.realPath || path.basename(fileRealPath) !== fileName) {
    throw new Error("Receipt-state file resolved outside its validated parent directory.");
  }
  await assertReceiptDirectoryContinuity(directory);
}

/** @param {string} root @param {"receipts" | "mutations"} kind @param {string} fileName @param {unknown} value @param {string} existsMessage */
async function writeStateJsonExclusive(root, kind, fileName, value, existsMessage) {
  const directory = await openSecureReceiptStateDirectory(root, kind);
  let handle;
  try {
    await assertReceiptDirectoryContinuity(directory);
    const filePath = path.join(directory.directoryPath, fileName);
    handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await assertReceiptStateFileContinuity(directory, fileName, handle);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await assertReceiptStateFileContinuity(directory, fileName, handle);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) throw new Error(existsMessage);
    if (hasErrorCode(error, "ELOOP")) {
      throw new Error("Receipt-state files must not be symbolic links.");
    }
    throw error;
  } finally {
    await handle?.close();
    await directory.handle.close();
  }
}

/** @param {string} root @param {"receipts" | "mutations"} kind @param {string} fileName */
async function readStateJson(root, kind, fileName) {
  const directory = await openSecureReceiptStateDirectory(root, kind);
  let handle;
  try {
    await assertReceiptDirectoryContinuity(directory);
    const filePath = path.join(directory.directoryPath, fileName);
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    await assertReceiptStateFileContinuity(directory, fileName, handle);
    const value = JSON.parse(await handle.readFile("utf8"));
    await assertReceiptStateFileContinuity(directory, fileName, handle);
    return value;
  } catch (error) {
    if (hasErrorCode(error, "ELOOP")) throw new Error("Receipt-state files must not be symbolic links.");
    throw error;
  } finally {
    await handle?.close();
    await directory.handle.close();
  }
}

/** @param {string} root @param {Record<string, string>} options */
async function readReceiptContext(root, options) {
  const requestPath = required(options, "request");
  await readExternalOperationRequest(root, requestPath);
  const request = await readJson(path.isAbsolute(requestPath) ? requestPath : path.join(root, requestPath));
  if (!Number.isInteger(request.issue) || request.issue < 1) throw new Error("Receipt request Issue must be a positive integer.");
  const contract = await readJson(path.join(root, ".artifacts", "issues", String(request.issue), "issue-contract.json"));
  return {
    root,
    contract,
    request,
    executionSurface: required(options, "surface"),
  };
}

/** @param {string} root @param {unknown} preflight @param {Record<string, any>} baseContext */
async function restoreValidatedPreflight(root, preflight, baseContext) {
  const preflightReceipt = /** @type {Record<string, any>} */ (preflight);
  if (!preflight || typeof preflight !== "object" || typeof preflightReceipt.receiptId !== "string") {
    throw new Error("Execution requires a valid preflight receipt.");
  }
  let validatedState;
  try {
    validatedState = await readStateJson(root, "receipts", validatedReceiptStateFileName(preflightReceipt.receiptId));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("Execution requires a validated preflight receipt.");
    }
    throw error;
  }
  if (validatedState.preflightDigest !== digestValue(preflight)) {
    throw new Error("Persisted preflight receipt digest mismatch.");
  }
  const receiptState = createOperationReceiptState();
  const validatedPreflight = validatePreflightReceipt(preflight, {
    ...baseContext,
    now: validatedState.validatedAt,
    receiptState,
  });
  if (validatedState.validationDigest !== digestValue(validatedPreflight)) {
    throw new Error("Persisted preflight validation evidence mismatch.");
  }
  return { receiptState, validatedState, validatedPreflight };
}

export async function runCli(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  const root = path.resolve(options.root ?? repositoryRoot);
  if (["validate-preflight", "claim-execution", "validate-result"].includes(command) && options.now !== undefined) {
    throw new Error("--now is not accepted by production receipt commands; the trusted runtime clock is used.");
  }
  if (["validate-preflight", "claim-execution", "validate-result"].includes(command)) {
    throw new Error(
      `Unsupported caller-authored receipt command: ${command}. Execution authority is available only through a provider-specific guarded adapter that collects live observations internally.`,
    );
  }

  if (command === "snapshot") {
    const input = await readJson(required(options, "input"));
    const output = resolveInside(root, required(options, "output"), path.join(".artifacts", "issues"));
    const contract = snapshotIssueContract(input, required(options, "fetched-at"), loadProtectedAuthority(root, "main"));
    await writeJson(output, contract);
    printJson({ ok: true, issue: contract.issue, digest: contract.digest, output: path.relative(root, output).replaceAll("\\", "/") });
    return;
  }

  if (command === "validate-request") {
    printJson(await readExternalOperationRequest(root, required(options, "file")));
    return;
  }

  if (command === "validate-preflight") {
    const receipt = await readJson(required(options, "file"));
    const receiptState = createOperationReceiptState();
    const baseContext = await readReceiptContext(root, options);
    const validatedAt = new Date().toISOString();
    const validated = validatePreflightReceipt(receipt, {
      ...baseContext,
      now: validatedAt,
      receiptState,
    });
    await writeStateJsonExclusive(root, "receipts", validatedReceiptStateFileName(validated.receiptId), {
      schemaVersion: 1,
      receiptId: validated.receiptId,
      preflightDigest: digestValue(receipt),
      requestDigest: validated.requestDigest,
      mutationDigest: validated.mutationDigest,
      validatedAt,
      validationDigest: digestValue(validated),
      evidence: validated,
    }, "Receipt ID has already been validated; reuse is forbidden.");
    printJson(validated);
    return;
  }

  if (command === "claim-execution") {
    const preflight = await readJson(required(options, "preflight"));
    const baseContext = await readReceiptContext(root, options);
    const { receiptState } = await restoreValidatedPreflight(root, preflight, baseContext);
    const claim = claimOperationExecution(preflight.receiptId, { receiptState, now: new Date().toISOString() });
    await writeStateJsonExclusive(root, "mutations", mutationStateFileName(claim.mutationDigest, "claim"), {
      schemaVersion: 1,
      receiptId: claim.receiptId,
      requestId: claim.requestId,
      requestDigest: claim.requestDigest,
      mutationDigest: claim.mutationDigest,
      startedAt: claim.startedAt,
      claimDigest: digestValue(claim),
      evidence: claim,
    }, "The same mutation has already been claimed; retry is forbidden.");
    printJson(claim);
    return;
  }

  if (command === "validate-result") {
    const result = await readJson(required(options, "file"));
    const preflight = await readJson(required(options, "preflight"));
    const baseContext = await readReceiptContext(root, options);
    const { receiptState } = await restoreValidatedPreflight(root, preflight, baseContext);
    let persistedClaim;
    try {
      persistedClaim = await readStateJson(root, "mutations", mutationStateFileName(preflight.mutationDigest, "claim"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new Error("Operation result requires an atomic execution claim before mutation.");
      }
      throw error;
    }
    if (
      persistedClaim.receiptId !== preflight.receiptId ||
      persistedClaim.requestDigest !== preflight.requestDigest ||
      persistedClaim.mutationDigest !== preflight.mutationDigest
    ) {
      throw new Error("Persisted execution claim does not match the receipt, request, and mutation digests.");
    }
    const claim = claimOperationExecution(preflight.receiptId, { receiptState, now: persistedClaim.startedAt });
    if (persistedClaim.claimDigest !== digestValue(claim)) throw new Error("Persisted execution claim digest mismatch.");
    const finalizedAt = new Date().toISOString();
    const validated = validateOperationResult(result, { ...baseContext, now: finalizedAt, receiptState });
    await writeStateJsonExclusive(root, "mutations", mutationStateFileName(validated.mutationDigest, "finalized"), {
      schemaVersion: 1,
      receiptId: validated.receiptId,
      requestDigest: validated.requestDigest,
      mutationDigest: validated.mutationDigest,
      resultDigest: digestValue(result),
      finalizedAt,
      evidence: validated,
    }, "Execution claim has already been finalized; result reuse is forbidden.");
    printJson(validated);
    return;
  }

  if (command === "prepare-review") {
    printJson(await prepareReviewArtifacts(root, await readJson(required(options, "input"))));
    return;
  }

  if (command === "record-review") {
    printJson(await recordReviewResult(
      root,
      positiveInteger(options, "issue"),
      await readJson(required(options, "file")),
    ));
    return;
  }

  if (command === "gate" || command === "render-pr") {
    const issue = positiveInteger(options, "issue");
    if (command === "gate") {
      printJson(await runAuthoritativePremergeGate(root, issue));
      return;
    }
    const body = await renderAuthoritativePullRequestBody(root, issue);
    if (options.output) {
      const output = resolveInside(root, options.output, path.join(".artifacts", "issues"));
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, body, "utf8");
    }
    process.stdout.write(body);
    return;
  }

  if (command === "cleanup-check") {
    printJson(collectAndValidateCleanupPlan(await readJson(required(options, "file")), root));
    return;
  }

  if (command === "request-merge") {
    printJson(await createMergeOperationRequest(
      root,
      positiveInteger(options, "issue"),
      positiveInteger(options, "pr-number"),
      {
        operatorLabel: required(options, "operator-label"),
        executionRole: required(options, "execution-role"),
        executionSurface: required(options, "surface"),
      },
    ));
    return;
  }
  if (command === "bind-external-evidence") {
    printJson(bindExternalOperationEvidence(root, required(options, "directory")));
    return;
  }

  if (command === "simulate") {
    const fixture = await readJson(required(options, "fixture"));
    printJson(await simulateWorkflowFixture(fixture, root));
    return;
  }

  if (command === "transition") {
    printJson(await transitionPersistedWorkflowState(
      root,
      positiveInteger(options, "issue"),
      required(options, "next"),
    ));
    return;
  }

  throw new Error("Usage: issue-workflow <snapshot|prepare-review|record-review|validate-request|validate-preflight|claim-execution|validate-result|gate|render-pr|request-merge|bind-external-evidence|cleanup-check|simulate|transition> [options]");
}

runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
