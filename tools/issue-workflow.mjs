import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectAndValidateCleanupPlan,
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
async function writeJsonExclusive(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("Receipt ID has already been validated or consumed; reuse is forbidden.");
    }
    throw error;
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

/** @param {string} root @param {string} receiptId @param {"validated" | "consumed"} phase */
function receiptStatePath(root, receiptId, phase) {
  return resolveInside(
    root,
    `.artifacts/ops-receipts/${receiptId}.${phase}.json`,
    path.join(".artifacts", "ops-receipts"),
  );
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
    now: required(options, "now"),
  };
}

export async function runCli(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  const root = path.resolve(options.root ?? repositoryRoot);

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
    const validated = validatePreflightReceipt(receipt, {
      ...await readReceiptContext(root, options),
      receiptState,
    });
    await writeJsonExclusive(receiptStatePath(root, validated.receiptId, "validated"), {
      schemaVersion: 1,
      receiptId: validated.receiptId,
      preflightDigest: digestValue(receipt),
      validatedAt: required(options, "now"),
      validationDigest: digestValue(validated),
      evidence: validated,
    });
    printJson(validated);
    return;
  }

  if (command === "validate-result") {
    const result = await readJson(required(options, "file"));
    const preflight = await readJson(required(options, "preflight"));
    if (!preflight || typeof preflight !== "object" || typeof preflight.receiptId !== "string") {
      throw new Error("Operation result requires a valid preflight receipt.");
    }
    let validatedState;
    try {
      validatedState = await readJson(receiptStatePath(root, preflight.receiptId, "validated"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new Error("Operation result requires a valid preflight receipt before execution.");
      }
      throw error;
    }
    if (validatedState.preflightDigest !== digestValue(preflight)) {
      throw new Error("Persisted preflight receipt digest mismatch.");
    }
    try {
      await readFile(receiptStatePath(root, preflight.receiptId, "consumed"), "utf8");
      throw new Error("Preflight receipt ID has already been consumed; result receipt reuse is forbidden.");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const receiptState = createOperationReceiptState();
    const baseContext = await readReceiptContext(root, options);
    const validatedPreflight = validatePreflightReceipt(preflight, {
      ...baseContext,
      now: validatedState.validatedAt,
      receiptState,
    });
    if (validatedState.validationDigest !== digestValue(validatedPreflight)) {
      throw new Error("Persisted preflight validation evidence mismatch.");
    }
    const validated = validateOperationResult(result, { ...baseContext, receiptState });
    await writeJsonExclusive(receiptStatePath(root, validated.receiptId, "consumed"), {
      schemaVersion: 1,
      receiptId: validated.receiptId,
      resultDigest: digestValue(result),
      consumedAt: required(options, "now"),
      evidence: validated,
    });
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

  throw new Error("Usage: issue-workflow <snapshot|prepare-review|record-review|validate-request|validate-preflight|validate-result|gate|render-pr|request-merge|cleanup-check|simulate|transition> [options]");
}

runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
