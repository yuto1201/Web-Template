import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextBinary = path.join(repositoryRoot, "node_modules", "next", "dist", "bin", "next");
const runningOnVercel = Boolean(process.env.VERCEL);
const requiredPublicVariables = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];
const serverOnlySentinel = ["sb", "secret", "SERVER_ONLY_BUILD_SENTINEL_1234567890"].join("_");

if (runningOnVercel) {
  const missingVariables = requiredPublicVariables.filter((name) => !process.env[name]?.trim());
  if (missingVariables.length > 0) {
    throw new Error(`Refusing CI placeholders on Vercel. Missing: ${missingVariables.join(", ")}.`);
  }
}

const safeEnvironment = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://template-placeholder.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_TEMPLATE_PUBLIC_VALUE_123456",
  SUPABASE_SERVICE_ROLE_KEY:
    process.env.SUPABASE_SERVICE_ROLE_KEY
    ?? (runningOnVercel ? "" : serverOnlySentinel),
};

/**
 * @param {string} command
 * @param {string[]} args
 */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: safeEnvironment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal || code !== 0) {
        reject(new Error(`Command failed with ${signal ?? `exit code ${code}`}.`));
        return;
      }
      resolve(undefined);
    });
  });
}

try {
  await run(process.execPath, [nextBinary, "build"]);
  await run(process.execPath, [path.join(repositoryRoot, "tools", "scan-client-bundle.mjs")]);
} catch (error) {
  console.error(error instanceof Error ? error.message : "CI build failed.");
  process.exitCode = 1;
}
