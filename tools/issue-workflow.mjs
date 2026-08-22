import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectAndValidateCleanupPlan,
  createMergeOperationRequest,
  prepareReviewArtifacts,
  readExternalOperationRequest,
  readExternalOperationResult,
  recordReviewResult,
  renderAuthoritativePullRequestBody,
  resolveInside,
  runAuthoritativePremergeGate,
  simulateWorkflowFixture,
  snapshotIssueContract,
  transitionPersistedWorkflowState,
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

/** @param {Record<string, string>} options @param {string[]} allowed */
function rejectUnknownOptions(options, allowed) {
  const unknown = Object.keys(options).filter((name) => !allowed.includes(name));
  if (unknown.length > 0) throw new Error(`Unknown option --${unknown[0]}.`);
}

/** @param {Record<string, string>} options */
function executionSurfaceOption(options) {
  const value = options["execution-surface"];
  if (value === undefined || value === "codex-local" || value === "claude-local" || value === "cursor-cloud") return value;
  throw new Error("--execution-surface must be codex-local, claude-local, or cursor-cloud.");
}

/** @param {unknown} value */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runCli(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  const root = path.resolve(options.root ?? repositoryRoot);

  if (command === "snapshot") {
    const input = await readJson(required(options, "input"));
    const output = resolveInside(root, required(options, "output"), path.join(".artifacts", "issues"));
    const contract = snapshotIssueContract(input, required(options, "fetched-at"));
    await writeJson(output, contract);
    printJson({ ok: true, issue: contract.issue, digest: contract.digest, output: path.relative(root, output).replaceAll("\\", "/") });
    return;
  }

  if (command === "validate-request") {
    rejectUnknownOptions(options, ["root", "file"]);
    printJson(await readExternalOperationRequest(root, required(options, "file")));
    return;
  }

  if (command === "validate-result") {
    rejectUnknownOptions(options, ["root", "file"]);
    printJson(await readExternalOperationResult(root, required(options, "file")));
    return;
  }

  if (command === "prepare-review") {
    printJson(await prepareReviewArtifacts(root, await readJson(required(options, "input"))));
    return;
  }

  if (command === "record-review") {
    rejectUnknownOptions(options, ["root", "issue", "file"]);
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
    rejectUnknownOptions(options, ["root", "issue", "pr-number", "execution-surface", "run-id", "activation-evidence"]);
    printJson(await createMergeOperationRequest(
      root,
      positiveInteger(options, "issue"),
      positiveInteger(options, "pr-number"),
      {
        executionSurface: executionSurfaceOption(options),
        runId: options["run-id"],
        activationEvidenceRef: options["activation-evidence"] ?? null,
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

  throw new Error("Usage: issue-workflow <snapshot|prepare-review|record-review|validate-request|validate-result|gate|render-pr|request-merge|cleanup-check|simulate|transition> [options]");
}

runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
