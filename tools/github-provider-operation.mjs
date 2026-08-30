import path from "node:path";
import { fileURLToPath } from "node:url";
import { executeRegisteredProviderOperation } from "./provider-guarded-adapter.mjs";

const modulePath = fileURLToPath(import.meta.url);

/** @param {string[]} argv */
export async function runCli(argv = process.argv.slice(2)) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error("Expected --name value options.");
    options[key.slice(2)] = value;
  }
  const root = path.resolve(options.root ?? ".");
  const requestPath = options.request;
  const modelFamily = options["model-family"];
  if (!requestPath) throw new Error("Missing --request.");
  if (!modelFamily || !["gpt", "claude", "cursor", "xai"].includes(modelFamily)) throw new Error("Missing or invalid --model-family gpt|claude|cursor|xai.");
  const result = await executeRegisteredProviderOperation({
    service: "github",
    root,
    requestPath,
    modelFamily: /** @type {"gpt" | "claude" | "cursor" | "xai"} */ (modelFamily),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === modulePath) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
