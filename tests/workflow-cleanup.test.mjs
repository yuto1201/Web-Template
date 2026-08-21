import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectAndValidateCleanupPlan, validateCleanupPlan } from "../tools/workflow-core.mjs";

const headSha = "2".repeat(40);
const mergeCommit = "4".repeat(40);
const root = path.resolve("C:/workspace/web-template");

function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    issue: 5,
    repository: "yuto1201/Web-Template",
    pr: {
      number: 15,
      state: "MERGED",
      headRefName: "codex/5-cross-model-workflow",
      headRefOid: headSha,
      mergeCommit,
    },
    recordedHeadSha: headSha,
    branch: "codex/5-cross-model-workflow",
    worktree: ".worktrees/5-cross-model-workflow",
    worktreeClean: true,
    remoteBranchDeleted: true,
    localBranchSha: headSha,
    candidateBranches: ["codex/5-cross-model-workflow"],
    candidateWorktrees: [".worktrees/5-cross-model-workflow"],
    ...overrides,
  };
}

describe("exact-target cleanup guard", () => {
  it("returns only the exact worktree and branch after merge evidence", () => {
    expect(validateCleanupPlan(plan(), root)).toEqual({
      safe: true,
      localActions: [
        { operation: "git.worktree.remove", target: ".worktrees/5-cross-model-workflow" },
        { operation: "git.branch.delete", target: "codex/5-cross-model-workflow" },
      ],
      preservedCandidates: { branches: [], worktrees: [] },
    });
  });

  it.each([
    ["an unmerged PR", { pr: { ...plan().pr, state: "OPEN", mergeCommit: null } }],
    ["a dirty worktree", { worktreeClean: false }],
    ["a stale recorded SHA", { recordedHeadSha: "9".repeat(40) }],
    ["an undeleted remote branch", { remoteBranchDeleted: false }],
    ["ambiguous branches", { candidateBranches: ["codex/5-cross-model-workflow", "codex/5-other"] }],
    ["ambiguous worktrees", { candidateWorktrees: [".worktrees/5-cross-model-workflow", ".worktrees/5-other"] }],
    ["an unrelated branch", { branch: "codex/6-unrelated" }],
    ["an unrelated worktree", { worktree: ".worktrees/6-unrelated", candidateWorktrees: [".worktrees/6-unrelated"] }],
    ["a traversal worktree", { worktree: ".worktrees/5-safe/../6-unrelated", candidateWorktrees: [".worktrees/5-safe/../6-unrelated"] }],
    ["a non-canonical Windows worktree", { worktree: ".worktrees\\5-cross-model-workflow", candidateWorktrees: [".worktrees\\5-cross-model-workflow"] }],
    ["a mismatched local branch SHA", { localBranchSha: "8".repeat(40) }],
  ])("refuses %s", (_label, override) => {
    expect(() => validateCleanupPlan(plan(override), root)).toThrow();
  });

  it("re-derives clean, SHA, branch, and worktree facts from git", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "web-template-cleanup-"));
    /** @param {string[]} args */
    const git = (...args) => spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true });
    expect(git("init", "--initial-branch=main").status).toBe(0);
    expect(git("config", "user.name", "Cleanup Fixture").status).toBe(0);
    expect(git("config", "user.email", "cleanup@example.invalid").status).toBe(0);
    await writeFile(path.join(repository, "README.md"), "cleanup fixture\n", "utf8");
    expect(git("add", "README.md").status).toBe(0);
    expect(git("commit", "-m", "base").status).toBe(0);
    const fixtureHead = git("rev-parse", "HEAD").stdout.trim();
    expect(git("branch", "codex/5-cross-model-workflow").status).toBe(0);
    expect(git("worktree", "add", ".worktrees/5-cross-model-workflow", "codex/5-cross-model-workflow").status).toBe(0);
    const evidence = {
      schemaVersion: 1,
      issue: 5,
      repository: "yuto1201/Web-Template",
      pr: { number: 15, state: "MERGED", headRefName: "codex/5-cross-model-workflow", headRefOid: fixtureHead, mergeCommit },
      recordedHeadSha: fixtureHead,
      branch: "codex/5-cross-model-workflow",
      worktree: ".worktrees/5-cross-model-workflow",
      remoteBranchDeleted: true,
    };
    expect(collectAndValidateCleanupPlan(evidence, repository).safe).toBe(true);

    await writeFile(path.join(repository, ".worktrees", "5-cross-model-workflow", "dirty.txt"), "dirty\n", "utf8");
    expect(() => collectAndValidateCleanupPlan(evidence, repository)).toThrow(/dirty/u);
  });
});
