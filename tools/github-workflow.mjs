import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planGitHubWorkflow, runGitHubWorkflow } from "./github-workflow-core.mjs";

/** @param {string[]} [args] */
export async function runCli(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command !== "plan" && command !== "run") throw new Error("Use plan --input file.json or run --request file.json; optional --root directory.");
  /** @type {Record<string,string>} */
  const options = {};
  const inputKey = command === "plan" ? "input" : "request";
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]?.slice(2);
    const value = rest[index + 1];
    if (!rest[index]?.startsWith("--") || ![inputKey, "root"].includes(key) || !value || value.startsWith("--") || options[key]) throw new Error("Unknown, duplicate or missing workflow option.");
    options[key] = value;
  }
  if (!options[inputKey]) throw new Error(`Missing --${inputKey}.`);
  const root = path.resolve(options.root ?? ".");
  const raw = await readFile(path.resolve(options[inputKey]), "utf8");
  if (raw.length > 160000) throw new Error("Workflow input is too large.");
  const result = command === "plan" ? await planGitHubWorkflow(root, JSON.parse(raw)) : await runGitHubWorkflow(root, JSON.parse(raw));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runCli().catch(() => {
    // Input/provider messages may contain private text. Detailed receipts contain digests only.
    console.error("GitHub workflow failed closed. Inspect the local journal and provider state; do not automatically retry writes.");
    process.exitCode = 1;
  });
}
