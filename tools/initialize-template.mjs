import { readFile } from "node:fs/promises";
import path from "node:path";
import { initializeTemplate } from "./template-core.mjs";

/** @param {string[]} args */
function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) {
    throw new Error("Usage: initialize-template --config <json-file>");
  }
  return path.resolve(args[1]);
}

try {
  const root = process.cwd();
  const configPath = parseArguments(process.argv.slice(2));
  const result = await initializeTemplate(root, JSON.parse(await readFile(configPath, "utf8")));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
