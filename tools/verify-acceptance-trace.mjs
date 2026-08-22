import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

try {
  const root = process.cwd();
  const trace = JSON.parse(await readFile(path.join(root, "config", "acceptance.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (trace.schemaVersion !== 1 || !Array.isArray(trace.issues)) throw new Error("config/acceptance.json is malformed.");
  const issueNumbers = trace.issues.map(/** @param {Record<string, any>} entry */ (entry) => entry.issue);
  if (JSON.stringify(issueNumbers) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 19, 29])) {
    throw new Error("Acceptance trace must cover Issues #1 through #8, #19, and #29 exactly once and in order.");
  }
  let evidenceCount = 0;
  for (const entry of trace.issues) {
    if (!entry.title || !Array.isArray(entry.evidence) || entry.evidence.length === 0 || !Array.isArray(entry.commands) || entry.commands.length === 0) {
      throw new Error(`Issue #${entry.issue} needs a title, evidence, and commands.`);
    }
    for (const relative of entry.evidence) {
      const resolved = path.resolve(root, relative);
      const withinRoot = path.relative(root, resolved);
      if (withinRoot === ".." || withinRoot.startsWith(`..${path.sep}`) || path.isAbsolute(withinRoot)) throw new Error(`Issue #${entry.issue} evidence escapes the repository.`);
      const metadata = await lstat(resolved);
      if (!metadata.isFile()) throw new Error(`Issue #${entry.issue} evidence is not a file: ${relative}.`);
      evidenceCount += 1;
    }
    for (const command of entry.commands) {
      if (!packageJson.scripts?.[command]) throw new Error(`Issue #${entry.issue} references missing npm script: ${command}.`);
    }
    if (
      entry.issue === 29 &&
      JSON.stringify(entry.commands) !== JSON.stringify(["cursor:doctor", "check:generated", "policy", "test", "check"])
    ) {
      throw new Error("Issue #29 must retain the canonical Cursor acceptance commands.");
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: true, issues: issueNumbers.length, evidenceFiles: evidenceCount }, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
