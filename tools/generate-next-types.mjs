import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedTypes = path.join(repositoryRoot, ".next", "types");
const nextBinary = path.join(repositoryRoot, "node_modules", "next", "dist", "bin", "next");

await rm(generatedTypes, { recursive: true, force: true });
const result = spawnSync(process.execPath, [nextBinary, "typegen"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  windowsHide: true,
  stdio: "inherit",
});
if (result.status !== 0 || result.error) {
  throw new Error(`Next type generation failed: ${result.error?.message ?? `exit code ${result.status}`}`);
}
