import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readExternalOperationRequest } from "../tools/workflow-core.mjs";

const repositoryRoot = path.resolve(".");

describe("provider-free Issue workflow simulation", () => {
  it("runs from claim through an approved squash-merge request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "web-template-e2e-"));
    const command = spawnSync(process.execPath, [
      path.join(repositoryRoot, "tools", "issue-workflow.mjs"),
      "simulate",
      "--fixture",
      path.join(repositoryRoot, "tests", "fixtures", "workflow", "happy-path.json"),
      "--root",
      root,
    ], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });

    expect(command.status, command.stderr).toBe(0);
    const result = JSON.parse(command.stdout);
    expect(result.state.current).toBe("approved-for-merge");
    expect(result.branch).toBe("cursor/42-workflow-fixture");
    expect(result.gate).toMatchObject({
      ok: true,
      issue: 42,
      risk: { level: "high" },
      reviewers: [{ family: "anthropic" }, { family: "openai" }],
    });
    expect(result.request).toMatchObject({
      operation: "github.merge_pr",
      inputs: { issue: 42, method: "squash", headSha: result.headSha },
      resolvedTarget: "yuto1201/Web-Template",
    });

    expect(Object.keys(result.paths)).toHaveLength(7);
    expect(result.paths.reviews).toEqual([
      `.artifacts/issues/42/${result.headSha}/reviews/anthropic.json`,
      `.artifacts/issues/42/${result.headSha}/reviews/openai.json`,
    ]);
    const artifactPaths = Object.entries(result.paths).flatMap(([key, value]) => key === "reviews" ? value : [value]);
    for (const artifact of artifactPaths) {
      await expect(stat(path.join(root, artifact))).resolves.toBeDefined();
    }

    const state = JSON.parse(await readFile(path.join(root, ".artifacts", "issues", "42", "state.json"), "utf8"));
    expect(state.transitions.map(/** @param {{ current: string }} transition */ (transition) => transition.current)).toEqual([
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
    expect(prBody).toContain("Execution surface: cursor-cloud");
    expect(prBody).toContain("Primary: cursor (composer-2.5)");
    expect(prBody).toContain("Risk: high");
    expect(prBody).toContain("Reviewer anthropic:");
    expect(prBody).toContain("Reviewer openai:");
    expect(prBody).toContain("## External changes");
    expect(prBody).toContain("Closes \\#999");
    expect(prBody).not.toContain("@reviewers");
  });
});
