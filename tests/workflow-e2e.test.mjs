import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { digestValue, readExternalOperationRequest } from "../tools/workflow-core.mjs";

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
    expect(result.gate).toMatchObject({ ok: true, issue: 42, reviewer: "claude" });
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
    expect(prBody).toContain("## External changes");
    expect(prBody).toContain("Closes \\#999");
    expect(prBody).not.toContain("@reviewers");
  });

  it("validates receipt CLI commands with process-persistent one-use consumption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "web-template-receipt-e2e-"));
    const simulation = spawnSync(process.execPath, [
      path.join(repositoryRoot, "tools", "issue-workflow.mjs"),
      "simulate",
      "--fixture",
      path.join(repositoryRoot, "tests", "fixtures", "workflow", "happy-path.json"),
      "--root",
      root,
    ], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
    expect(simulation.status, simulation.stderr).toBe(0);
    const simulated = JSON.parse(simulation.stdout);
    const requestPath = path.join(root, simulated.paths.mergeRequest);
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    const contract = JSON.parse(await readFile(path.join(root, simulated.paths.contract), "utf8"));
    const authority = JSON.parse(await readFile(path.join(root, "config", "ownership.json"), "utf8"));
    const observation = {
      account: { ...authority.accounts.github, ...authority.observations.github },
      target: { ...authority.resourceTargets.github },
    };
    const receipt = {
      schemaVersion: 1,
      receiptId: "receipt-issue-42-github-merge-pr-1",
      requestId: request.requestId,
      service: "github",
      operatorLabel: request.operatorLabel,
      executionRole: request.executionRole,
      executionSurface: request.executionSurface,
      authorityDigest: contract.authority.digest,
      issueContractDigest: contract.digest,
      authorizationDigest: digestValue(contract.externalAuthorizations[0]),
      requestDigest: digestValue(request),
      mutationDigest: digestValue(request.inputs),
      accountObservation: observation.account,
      targetObservation: observation.target,
      observedAt: "2026-08-30T01:00:00Z",
      expiresAt: "2026-08-30T01:02:00Z",
    };
    const result = {
      schemaVersion: 1,
      receiptId: receipt.receiptId,
      requestId: receipt.requestId,
      service: receipt.service,
      operatorLabel: receipt.operatorLabel,
      executionRole: receipt.executionRole,
      executionSurface: receipt.executionSurface,
      authorityDigest: receipt.authorityDigest,
      issueContractDigest: receipt.issueContractDigest,
      authorizationDigest: receipt.authorizationDigest,
      requestDigest: receipt.requestDigest,
      mutationDigest: receipt.mutationDigest,
      preflight: {
        accountObservation: observation.account,
        targetObservation: observation.target,
        observedAt: receipt.observedAt,
      },
      postflight: {
        accountObservation: observation.account,
        targetObservation: observation.target,
        observedAt: "2026-08-30T01:01:30Z",
      },
      outcome: { status: "succeeded", evidenceDigest: `sha256:${"7".repeat(64)}` },
    };
    const receiptPath = path.join(root, "preflight.json");
    const resultPath = path.join(root, "result.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

    const preflight = spawnSync(process.execPath, [
      path.join(repositoryRoot, "tools", "issue-workflow.mjs"),
      "validate-preflight",
      "--file", receiptPath,
      "--request", requestPath,
      "--surface", "github-cli",
      "--now", "2026-08-30T01:01:00Z",
      "--root", root,
    ], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
    expect(preflight.status, preflight.stderr).toBe(0);
    expect(JSON.parse(preflight.stdout)).toMatchObject({ ok: true, receiptId: receipt.receiptId });
    expect(preflight.stdout).not.toContain("fixture-user");

    const resultArgs = [
      path.join(repositoryRoot, "tools", "issue-workflow.mjs"),
      "validate-result",
      "--file", resultPath,
      "--preflight", receiptPath,
      "--request", requestPath,
      "--surface", "github-cli",
      "--now", "2026-08-30T01:01:45Z",
      "--root", root,
    ];
    const validatedResult = spawnSync(process.execPath, resultArgs, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
    expect(validatedResult.status, validatedResult.stderr).toBe(0);
    expect(JSON.parse(validatedResult.stdout)).toMatchObject({ ok: true, consumed: true, outcome: "succeeded" });
    expect(validatedResult.stdout).not.toContain("fixture-user");

    const reused = spawnSync(process.execPath, resultArgs, { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
    expect(reused.status).not.toBe(0);
    expect(reused.stderr).toMatch(/consumed|reuse/u);
  });
});
