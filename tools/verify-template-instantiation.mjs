import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { discoverOccurrences, projectTokens, readTemplateState } from "./template-core.mjs";

/** @param {string} command @param {string[]} args @param {string} cwd @param {string} label */
function run(command, args, cwd, label) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 || result.error) {
    throw new Error(`${label} failed.\n${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim());
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/** @param {string} source @param {string} target */
async function copyProject(source, target) {
  const listing = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], source, "enumerate template files");
  for (const relative of listing.split("\0").filter(Boolean)) {
    const from = path.join(source, relative);
    const to = path.join(target, relative);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

const source = process.cwd();
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this verifier through npm run template:verify.");
const temporaryParent = path.resolve(os.tmpdir());
const target = await mkdtemp(path.join(temporaryParent, "web-starter-clean-room-"));
try {
  const sourceState = await readTemplateState(source);
  await copyProject(source, target);
  const config = {
    schemaVersion: 1,
    appName: "Clean Room App",
    slug: "clean-room-app",
    github: { owner: "example-owner", repository: "clean-room-app" },
    localPorts: { app: 4310, supabaseBase: 56320 },
    publicUrls: { production: "https://clean-room-app.example.invalid" },
    ownership: {
      supabase: { organizationName: null, projectRef: null },
      vercel: { scope: null, projectId: null },
      cloudflare: { accountId: null, accountName: null, zoneId: null, zoneName: "example.invalid" },
    },
  };
  const inputDirectory = path.join(target, ".artifacts");
  await mkdir(inputDirectory, { recursive: true });
  const inputPath = path.join(inputDirectory, "template-init.json");
  await writeFile(inputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const first = run(process.execPath, ["tools/initialize-template.mjs", "--config", inputPath], target, "first initialization");
  const second = run(process.execPath, ["tools/initialize-template.mjs", "--config", inputPath], target, "idempotence check");
  if (!first.includes('"status": "initialized"') || !second.includes('"status": "idempotent"')) {
    throw new Error("Initialization did not report initialized then idempotent status.");
  }
  const leakage = await discoverOccurrences(target, projectTokens(sourceState.project));
  const leakedFiles = [...new Set(Object.values(leakage).flatMap((files) => Object.keys(files)))];
  if (leakedFiles.length > 0) throw new Error(`Template source values leaked into clean-room output: ${leakedFiles.join(", ")}`);

  run("git", ["init", "--quiet"], target, "initialize clean-room git repository");
  run("git", ["add", "-A"], target, "stage clean-room files for policy inspection");
  run(process.execPath, [npmCli, "ci"], target, "install clean-room dependencies");
  run(process.execPath, [npmCli, "run", "check"], target, "run clean-room repository checks");
  const readiness = run(process.execPath, [npmCli, "run", "readiness"], target, "verify clean-room readiness distinction");
  if (!readiness.includes('"status": "ready"') || !readiness.includes('"status": "needs-codex"')) {
    throw new Error("Clean-room readiness did not distinguish local readiness from pending live providers.");
  }
  run(process.execPath, [npmCli, "run", "test:e2e"], target, "run clean-room browser smoke checks");
  const generatedPackage = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: "clean-room-verified",
    packageName: generatedPackage.name,
    sourceLeakage: 0,
    idempotence: "passed",
    checks: "passed",
    readiness: "passed",
    browserSmoke: "passed",
  }, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  const relative = path.relative(temporaryParent, target);
  if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    await rm(target, { recursive: true, force: true });
  }
}
