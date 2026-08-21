import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "server-only-app");
const fixtureOutput = path.join(fixtureRoot, ".next");
const nextBinary = path.join(repositoryRoot, "node_modules", "next", "dist", "bin", "next");

function buildViolationFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nextBinary, "build", fixtureRoot], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: "https://template-placeholder.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_TEMPLATE_PUBLIC_VALUE_123456",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

try {
  const result = await buildViolationFixture();
  const expectedDiagnostic = /['"]server-only['"] cannot be imported from a Client Component module/iu.test(result.output)
    && /src[\\/]lib[\\/]env[\\/]server\.ts/iu.test(result.output);
  if (result.code === 0 || !expectedDiagnostic) {
    console.error("Server-only boundary verification did not observe the expected denied build.");
    process.exitCode = 1;
  } else {
    console.warn("Server-only boundary verification passed with the expected denied build.");
  }
} catch (error) {
  console.error(`Server-only boundary verification failed to execute: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  await rm(fixtureOutput, { recursive: true, force: true });
}
