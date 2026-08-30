import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  lintDeploymentWorkflows,
  validateDeploymentPreflight,
  validateReleaseEvidence,
  validateRemoteSchemaOrder,
} from "./deployment-core.mjs";

const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");

/** @param {string[]} args */
function options(args) {
  /** @type {Record<string, string>} */
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Expected --name value options.");
    result[key.slice(2)] = value;
  }
  return result;
}

/** @param {Record<string, string>} values @param {string} key */
function required(values, key) {
  if (!values[key]) throw new Error(`Missing --${key}.`);
  return values[key];
}

async function run() {
  const [command, ...args] = process.argv.slice(2);
  const values = options(args);
  if (values.root) throw new Error("--root is not permitted; canonical ownership is repository-bound.");
  const root = repositoryRoot;
  if (["preflight", "verify-release"].includes(command)) {
    throw new Error(`Unsupported legacy deployment command: ${command}. Use the provider-specific guarded adapter with a registered operation.`);
  }
  if (command === "preflight") {
    const snapshot = JSON.parse(await readFile(path.resolve(required(values, "env-snapshot")), "utf8"));
    process.stdout.write(`${JSON.stringify(await validateDeploymentPreflight(snapshot, root), null, 2)}\n`);
    return;
  }
  if (command === "verify-release") {
    const evidencePath = path.resolve(required(values, "evidence"));
    const evidenceRoot = path.join(root, ".artifacts");
    const relativeEvidencePath = path.relative(evidenceRoot, evidencePath);
    if (relativeEvidencePath !== "vercel-release-evidence.json") {
      throw new Error("Release evidence must be the same-run .artifacts/vercel-release-evidence.json file.");
    }
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    process.stdout.write(`${JSON.stringify(validateReleaseEvidence(evidence, required(values, "expected-sha")), null, 2)}\n`);
    return;
  }
  if (command === "lint") {
    const errors = await lintDeploymentWorkflows(root);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    process.stdout.write(`${JSON.stringify({ ok: true, checkpoint: "workflow-lint", schemaOrder: validateRemoteSchemaOrder() }, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: deployment-workflow <preflight|verify-release|lint> [options]");
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
