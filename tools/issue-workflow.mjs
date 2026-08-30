import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
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

/** @param {string} filePath @param {unknown} value */
async function writeJsonExclusive(filePath, value, existsMessage) {
  let handle;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    handle = await open(filePath, flags, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(existsMessage);
    }
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      throw new Error("Receipt-state files must not be symbolic links.");
    }
    throw error;
  } finally {
    await handle?.close();
  }
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

/** @param {string} root @param {"receipts" | "mutations"} kind */
async function secureReceiptStateDirectory(root, kind) {
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of [".artifacts", "ops-receipts", kind]) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!(mkdirError && typeof mkdirError === "object" && "code" in mkdirError && mkdirError.code === "EEXIST")) throw mkdirError;
      }
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink()) throw new Error("Receipt-state parent directories must not be symbolic links.");
    if (!entry.isDirectory()) throw new Error("Receipt-state parent path must be a directory.");
    if (await realpath(current) !== current) throw new Error("Receipt-state parent directory resolved outside its canonical path.");
  }
  return current;
}

/** @param {string} root @param {string} receiptId */
async function validatedReceiptStatePath(root, receiptId) {
  if (!/^receipt-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(receiptId)) throw new Error("Receipt ID is not a canonical state key.");
  return path.join(await secureReceiptStateDirectory(root, "receipts"), `${receiptId}.validated.json`);
}

/** @param {string} root @param {string} mutationDigest @param {"claim" | "finalized"} phase */
async function mutationStatePath(root, mutationDigest, phase) {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(mutationDigest);
  if (!match) throw new Error("Mutation digest is not a canonical state key.");
  return path.join(await secureReceiptStateDirectory(root, "mutations"), `${match[1]}.${phase}.json`);
}

/** @param {string} filePath */
async function readStateJson(filePath) {
  let handle;
  try {
    const entry = await lstat(filePath);
    if (entry.isSymbolicLink()) throw new Error("Receipt-state files must not be symbolic links.");
    if (!entry.isFile()) throw new Error("Receipt-state path must be a regular file.");
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      throw new Error("Receipt-state files must not be symbolic links.");
    }
    throw error;
  } finally {
    await handle?.close();
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
  if (!preflight || typeof preflight !== "object" || typeof preflight.receiptId !== "string") {
    throw new Error("Execution requires a valid preflight receipt.");
  }
  let validatedState;
  try {
    validatedState = await readStateJson(await validatedReceiptStatePath(root, preflight.receiptId));
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
    await writeJsonExclusive(await validatedReceiptStatePath(root, validated.receiptId), {
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
    await writeJsonExclusive(await mutationStatePath(root, claim.mutationDigest, "claim"), {
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
      persistedClaim = await readStateJson(await mutationStatePath(root, preflight.mutationDigest, "claim"));
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
    await writeJsonExclusive(await mutationStatePath(root, validated.mutationDigest, "finalized"), {
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

  throw new Error("Usage: issue-workflow <snapshot|prepare-review|record-review|validate-request|validate-preflight|claim-execution|validate-result|gate|render-pr|request-merge|cleanup-check|simulate|transition> [options]");
}

runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
