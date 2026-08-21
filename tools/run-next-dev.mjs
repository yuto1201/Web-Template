import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

try {
  const root = process.cwd();
  const template = JSON.parse(await readFile(path.join(root, "config", "template.json"), "utf8"));
  const port = template.project?.localPorts?.app;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("config/template.json has no valid application port.");
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "dev", "-p", String(port), ...process.argv.slice(2)], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = Number(exitCode);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
