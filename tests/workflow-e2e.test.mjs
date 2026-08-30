import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readExternalOperationRequest } from "../tools/workflow-core.mjs";

const repositoryRoot = path.resolve(".");

/** @param {string} root @param {string[]} args */
function runWorkflow(root, args) {
  return spawnSync(process.execPath, [
    path.join(repositoryRoot, "tools", "issue-workflow.mjs"),
    ...args,
    "--root",
    root,
  ], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
}

describe("provider-free Issue workflow simulation", { timeout: 20_000 }, () => {
  it("runs from claim through an approved squash-merge request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "web-template-e2e-"));
    const command = runWorkflow(root, [
      "simulate",
      "--fixture",
      path.join(repositoryRoot, "tests", "fixtures", "workflow", "happy-path.json"),
    ]);

    expect(command.status, command.stderr).toBe(0);
    const result = JSON.parse(command.stdout);
    expect(result.state.current).toBe("approved-for-merge");
    expect(result.gate).toMatchObject({
      ok: true,
      issue: 42,
      reviewerOperatorLabel: "claude",
      reviewerModelFamily: "claude",
    });
    expect(result.request).toMatchObject({
      operation: "github.merge_pr",
      inputs: { issue: 42, method: "squash", headSha: result.headSha },
      resolvedTarget: "yuto1201/Web-Template",
      authorization: {
        purposeCode: "reviewed-release",
        accountRef: "accounts.github",
        targetRef: "resourceTargets.github",
        requiresExactHead: true,
      },
    });

    expect(Object.keys(result.paths)).toHaveLength(7);
    for (const artifact of Object.values(result.paths)) {
      await expect(stat(path.join(root, artifact))).resolves.toBeDefined();
    }

    const state = /** @type {{transitions: Array<{current: string}>}} */ (JSON.parse(await readFile(path.join(root, ".artifacts", "issues", "42", "state.json"), "utf8")));
    expect(state.transitions.map((transition) => transition.current)).toEqual([
      "claimed",
      "in-progress",
      "verify-passed",
      "review-requested",
      "approved-for-merge",
    ]);

    const { request, resultPath } = await readExternalOperationRequest(root, result.paths.mergeRequest);
    expect(request.operation).toBe("github.merge_pr");
    expect(request).not.toHaveProperty("prompt");
    expect(resultPath).toBe(".artifacts/ops-results/issue-42-github-merge-pr-1.result.json");

    const prBody = await readFile(path.join(root, result.paths.pullRequest), "utf8");
    expect(prBody).toContain("Closes #42");
    expect(prBody).toContain(`Reviewed SHA: \`${result.headSha}\``);
    expect(prBody).toContain("## External changes");
    expect(prBody).toContain("Closes \\#999");
    expect(prBody).not.toContain("@reviewers");
  });

  it("fails closed for caller-authored receipt lifecycle commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "web-template-receipt-disabled-"));
    for (const commandName of ["validate-preflight", "claim-execution", "validate-result"]) {
      const command = runWorkflow(root, [commandName]);
      expect(command.status).not.toBe(0);
      expect(command.stderr).toMatch(/caller-authored receipt|guarded adapter/iu);
    }
  });
});
