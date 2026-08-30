import { spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveVerificationPlan, executionPolicySchema } from "./execution-policy.mjs";

/** @param {string} root @param {string[]} args @param {boolean} [buffer] */
function git(root, args, buffer = false) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: buffer ? undefined : "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || result.stdout === null) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : String(result.stderr ?? "").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return result.stdout;
}

/**
 * Derive a plan only from the actual merge-base diff and caller-supplied
 * trusted policy. Candidate PR text and candidate policy are not consulted.
 * @param {{root:string,baseSha:string,headSha:string,policy:unknown}} input
 */
export function createCiChangePlan(input) {
  const root = path.resolve(input.root);
  const policy = executionPolicySchema.parse(input.policy);
  const mergeBase = String(git(root, ["merge-base", input.baseSha, input.headSha])).trim();
  const changedPaths = /** @type {Buffer} */ (git(root, [
    "-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", mergeBase, input.headSha, "--",
  ], true)).toString("utf8").split("\0").filter(Boolean);
  return deriveVerificationPlan({ changedPaths, externalOperations: [] }, policy);
}

export function fullCiChangePlan() {
  return {
    risk: { level: "high", reasons: ["mode:full"] },
    repository: "full",
    databaseAuth: true,
    browser: true,
    macos: true,
    template: true,
  };
}

/** @param {string[]} argv */
function parseArguments(argv) {
  const allowed = new Set(["--root", "--base", "--head", "--policy", "--github-output"]);
  const values = new Map();
  let full = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--full") {
      if (full) throw new Error("--full may be supplied only once.");
      full = true;
      continue;
    }
    if (!allowed.has(argument) || values.has(argument)) throw new Error(`Unknown or duplicate argument ${argument}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    values.set(argument, value);
    index += 1;
  }
  if (!full) {
    for (const required of ["--base", "--head", "--policy"]) {
      if (!values.has(required)) throw new Error(`${required} is required unless --full is used.`);
    }
  }
  return {
    full,
    root: values.get("--root") ?? process.cwd(),
    baseSha: values.get("--base"),
    headSha: values.get("--head"),
    policyPath: values.get("--policy"),
    githubOutputPath: values.get("--github-output"),
  };
}

/** @param {ReturnType<typeof fullCiChangePlan>} plan */
function githubOutputs(plan) {
  return [
    `risk=${plan.risk.level}`,
    `repository=${plan.repository}`,
    `database_auth=${String(plan.databaseAuth)}`,
    `browser=${String(plan.browser)}`,
    `macos=${String(plan.macos)}`,
    `template=${String(plan.template)}`,
  ].join("\n") + "\n";
}

/** @param {string[]} [argv] */
export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const plan = args.full
    ? fullCiChangePlan()
    : createCiChangePlan({
      root: args.root,
      baseSha: /** @type {string} */ (args.baseSha),
      headSha: /** @type {string} */ (args.headSha),
      policy: JSON.parse(await readFile(path.resolve(/** @type {string} */ (args.policyPath)), "utf8")),
    });
  if (args.githubOutputPath) await appendFile(path.resolve(args.githubOutputPath), githubOutputs(plan), "utf8");
  process.stdout.write(`${JSON.stringify(plan)}\n`);
  return plan;
}

const modulePath = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] ?? "") === modulePath) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
