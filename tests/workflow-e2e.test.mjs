import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateGitHubReviewGate, parseReviewBody } from "../tools/github-review-gate.mjs";
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
    expect(prBody).toContain("Primary observed model: composer-2.5");
    expect(prBody).toContain("Risk: high");
    expect(prBody).toContain("Reviewer anthropic:");
    expect(prBody).toContain("Reviewer openai:");
    expect(prBody).toContain("## External changes");
    expect(prBody).toContain("Closes \\#999");
    expect(prBody).not.toContain("@reviewers");
    expect(parseReviewBody(prBody)).toMatchObject({
      executionSurface: "cursor-cloud",
      primaryModel: { configured: "composer-2.5", observed: "composer-2.5", family: "cursor", fallback: false },
      risk: { level: "high", reasons: ["operation:github.merge_pr"] },
      reviewedSha: result.headSha,
      reviews: [{ family: "anthropic" }, { family: "openai" }],
    });
    const workflow = JSON.parse(await readFile(path.join(repositoryRoot, "config", "workflow.json"), "utf8"));
    const executionPolicy = JSON.parse(await readFile(path.join(repositoryRoot, "config", "execution.json"), "utf8"));
    expect(evaluateGitHubReviewGate({
      event: {
        pull_request: {
          body: prBody,
          head: { sha: result.headSha, repo: { full_name: "yuto1201/Web-Template" } },
          base: { sha: "b".repeat(40), repo: { full_name: "yuto1201/Web-Template" } },
          user: { login: "yuto1201", id: 50611866, type: "User" },
        },
      },
      changedPaths: ["src/app/page.tsx"],
      diff: "",
      workflow,
      executionPolicy,
    })).toMatchObject({ ok: true, mode: "independent-review", headSha: result.headSha, risk: "high" });
  });
});
