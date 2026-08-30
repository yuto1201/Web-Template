import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCiChangePlan, fullCiChangePlan } from "../tools/ci-change-plan.mjs";

const trustedPolicy = JSON.parse(await readFile(path.resolve("config/execution.json"), "utf8"));

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

/** @param {Array<{path:string,content:string}>} changes */
async function repositoryWithChanges(changes) {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-template-ci-plan-"));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "CI Plan Fixture"]);
  git(root, ["config", "user.email", "ci-plan@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "# Base\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["switch", "-c", "candidate"]);
  for (const change of changes) {
    await mkdir(path.dirname(path.join(root, change.path)), { recursive: true });
    await writeFile(path.join(root, change.path), change.content, "utf8");
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "candidate"]);
  return { root, baseSha, headSha: git(root, ["rev-parse", "HEAD"]) };
}

describe("CI change plan", () => {
  it.each([
    [[{ path: "README.md", content: "# Clarified\n" }], { risk: { level: "low" }, repository: "docs", databaseAuth: false }],
    [[{ path: "src/app/page.tsx", content: "export default function Page() { return null; }\n" }], { risk: { level: "normal" }, repository: "full", browser: true }],
    [[{ path: "supabase/migrations/20260830000000_x.sql", content: "select 1;\n" }], { risk: { level: "high" }, repository: "full", databaseAuth: true, macos: true, template: true }],
  ])("derives a protected-base plan for %j", async (changes, expected) => {
    const repository = await repositoryWithChanges(changes);
    expect(createCiChangePlan({ ...repository, policy: trustedPolicy })).toMatchObject(expected);
  });

  it("ignores candidate policy edits when the caller supplies trusted policy", async () => {
    const candidatePolicy = structuredClone(trustedPolicy);
    candidatePolicy.lowRiskPathRules.push({ type: "exact", path: "src/app/page.tsx" });
    const repository = await repositoryWithChanges([
      { path: "config/execution.json", content: `${JSON.stringify(candidatePolicy, null, 2)}\n` },
      { path: "src/app/page.tsx", content: "export default function Page() { return null; }\n" },
    ]);
    expect(createCiChangePlan({ ...repository, policy: trustedPolicy }).risk)
      .toEqual({ level: "high", reasons: ["path:config/"] });
  });

  it("fails closed for an invalid policy and emits an explicit full plan", async () => {
    const repository = await repositoryWithChanges([{ path: "README.md", content: "# Changed\n" }]);
    expect(() => createCiChangePlan({ ...repository, policy: {} })).toThrow();
    expect(fullCiChangePlan()).toEqual({
      risk: { level: "high", reasons: ["mode:full"] },
      repository: "full",
      databaseAuth: true,
      browser: true,
      macos: true,
      template: true,
    });
  });

  it("writes canonical GitHub outputs and exits nonzero for invalid policy", async () => {
    const repository = await repositoryWithChanges([{ path: "README.md", content: "# Changed\n" }]);
    const outputPath = path.join(repository.root, "github-output.txt");
    const validPolicyPath = path.join(repository.root, "trusted-policy.json");
    const invalidPolicyPath = path.join(repository.root, "invalid-policy.json");
    await writeFile(validPolicyPath, `${JSON.stringify(trustedPolicy)}\n`, "utf8");
    await writeFile(invalidPolicyPath, "{}\n", "utf8");
    const cli = path.resolve("tools/ci-change-plan.mjs");
    const valid = spawnSync(process.execPath, [cli, "--root", repository.root, "--base", repository.baseSha, "--head", repository.headSha, "--policy", validPolicyPath, "--github-output", outputPath], { encoding: "utf8" });
    expect(valid.status, valid.stderr).toBe(0);
    expect(await readFile(outputPath, "utf8")).toBe("risk=low\nrepository=docs\ndatabase_auth=false\nbrowser=false\nmacos=false\ntemplate=false\n");
    const invalid = spawnSync(process.execPath, [cli, "--root", repository.root, "--base", repository.baseSha, "--head", repository.headSha, "--policy", invalidPolicyPath], { encoding: "utf8" });
    expect(invalid.status).not.toBe(0);
  });
});
