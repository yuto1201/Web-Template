import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDomainPlan,
  validateDomainApplyPreflight,
  validateDomainPolicy,
  validateDomainRollbackPreflight,
  verifyDnsChange,
  verifyDomainRelease,
} from "./domain-core.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string[]} args */
function parseOptions(args) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Expected --name value options.");
    values[key.slice(2)] = value;
  }
  return values;
}

/** @param {Record<string, string>} values @param {string} name */
function required(values, name) {
  if (!values[name]) throw new Error(`Missing --${name}.`);
  return values[name];
}

/** @param {string} filePath */
async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

async function run() {
  const [command, ...args] = process.argv.slice(2);
  const values = parseOptions(args);
  if (values.root) throw new Error("--root is not permitted; domain ownership is repository-bound.");
  if (["apply-preflight", "rollback-preflight"].includes(command)) {
    throw new Error(`Unsupported legacy mutation command: ${command}. Use the provider-specific guarded adapter with a registered operation.`);
  }
  let result;
  if (command === "lint") result = validateDomainPolicy();
  else if (command === "plan") result = createDomainPlan(await readJson(required(values, "input")));
  else if (command === "apply-preflight") result = validateDomainApplyPreflight(
    await readJson(required(values, "current")),
    await readJson(required(values, "plan")),
  );
  else if (command === "verify-dns") result = verifyDnsChange(await readJson(required(values, "after")), await readJson(required(values, "plan")));
  else if (command === "rollback-preflight") result = validateDomainRollbackPreflight(
    await readJson(required(values, "current")),
    await readJson(required(values, "plan")),
  );
  else if (command === "verify-release") result = verifyDomainRelease(
    await readJson(required(values, "evidence")),
    await readJson(required(values, "plan")),
    await readJson(required(values, "dns")),
  );
  else throw new Error("Usage: domain-workflow <lint|plan|apply-preflight|verify-dns|rollback-preflight|verify-release> [options]");
  if (values.output) {
    const output = path.resolve(values.output);
    const relative = path.relative(path.join(repositoryRoot, ".artifacts"), output);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Output must stay under .artifacts.");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
