import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ignoredDirectories = new Set([".artifacts", ".git", ".next", ".worktrees", "node_modules", "out", "playwright-report", "test-results"]);

/** @param {string} root @param {string} [relative] @returns {Promise<string[]>} */
async function markdownFiles(root, relative = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) result.push(...await markdownFiles(root, child));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) result.push(child);
  }
  return result;
}

/** @param {string} root */
export async function findBrokenMarkdownLinks(root) {
  const errors = [];
  for (const relative of await markdownFiles(root)) {
    const content = await readFile(path.join(root, relative), "utf8");
    const withoutFences = content.replace(/```[\s\S]*?```/gu, "").replace(/`[^`\r\n]*`/gu, "");
    for (const match of withoutFences.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
      const rawTarget = match[1].trim().replace(/^<|>$/gu, "");
      if (!rawTarget || rawTarget.startsWith("#") || rawTarget.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(rawTarget)) continue;
      const targetWithoutAnchor = rawTarget.split("#", 1)[0].split("?", 1)[0];
      let decoded;
      try {
        decoded = decodeURIComponent(targetWithoutAnchor);
      } catch {
        errors.push(`${relative}: invalid percent-encoding in ${rawTarget}.`);
        continue;
      }
      const resolved = path.resolve(path.dirname(path.join(root, relative)), decoded);
      const rootRelative = path.relative(root, resolved);
      if (rootRelative === ".." || rootRelative.startsWith(`..${path.sep}`) || path.isAbsolute(rootRelative)) {
        errors.push(`${relative}: link escapes the repository: ${rawTarget}.`);
        continue;
      }
      try {
        await lstat(resolved);
      } catch {
        errors.push(`${relative}: missing local link target: ${rawTarget}.`);
      }
    }
  }
  return errors.toSorted();
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const errors = await findBrokenMarkdownLinks(process.cwd());
  if (errors.length > 0) {
    errors.forEach((error) => console.error(error));
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ ok: true, check: "markdown-links" }, null, 2)}\n`);
  }
}
