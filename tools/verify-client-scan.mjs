import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanNextBrowserArtifacts } from "./scan-client-bundle.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests", "fixtures", "client-leak-app");
const fixtureOutput = path.join(fixtureRoot, ".next");
const nextBinary = path.join(repositoryRoot, "node_modules", "next", "dist", "bin", "next");
const sentinel = ["sb", "secret", "SERVER_ONLY_BUILD_SENTINEL_POSITIVE_CONTROL_123456"].join("_");
const clientSentinel = ["sb", "secret", "CLIENT_BUILD_SENTINEL_POSITIVE_CONTROL_123456"].join("_");

function buildLeakFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nextBinary, "build", fixtureRoot], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NEXT_PUBLIC_LEAK_CANARY: clientSentinel,
        SUPABASE_SERVICE_ROLE_KEY: sentinel,
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
  const build = await buildLeakFixture();
  if (build.code !== 0) {
    throw new Error("Positive-control fixture failed to build.");
  }
  const findings = await scanNextBrowserArtifacts(fixtureOutput, [
    { name: "SUPABASE_SERVICE_ROLE_KEY", value: sentinel },
  ]);
  const detectedStaticLeak = findings.some((finding) => (
    finding.label === "Supabase secret key" && finding.file.startsWith(`static${path.sep}`)
  ));
  const detectedRenderedLeak = findings.some((finding) => (
    finding.label === "Supabase secret key" && finding.file.startsWith(path.join("server", "app"))
  ));
  if (!detectedStaticLeak || !detectedRenderedLeak) {
    console.error("Browser artifact scanner missed a deliberate static or rendered leak positive control.");
    process.exitCode = 1;
  } else {
    console.warn("Browser artifact scanner detected its deliberate static and rendered leak controls.");
  }
} catch (error) {
  console.error(`Browser artifact positive control failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  await rm(fixtureOutput, { recursive: true, force: true });
}
