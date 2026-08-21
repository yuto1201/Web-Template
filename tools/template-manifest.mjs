import path from "node:path";
import { discoverOccurrences, projectTokens, readTemplateState, verifyTemplateSource } from "./template-core.mjs";

try {
  const root = process.cwd();
  const state = await readTemplateState(root);
  if (process.argv.includes("--print")) {
    const occurrences = await discoverOccurrences(root, projectTokens(state.project));
    process.stdout.write(`${JSON.stringify(occurrences, null, 2)}\n`);
  } else if (state.status === "initialized") {
    process.stdout.write(`${JSON.stringify({ ok: true, status: "initialized", sourceCheck: "not-applicable" }, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(await verifyTemplateSource(path.resolve(root), state), null, 2)}\n`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
