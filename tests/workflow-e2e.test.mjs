import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { digestValue, readExternalOperationRequest } from "../tools/workflow-core.mjs";

const repositoryRoot = path.resolve(".");

function runWorkflow(root, args) {
  return spawnSync(process.execPath, [
    path.join(repositoryRoot, "tools", "issue-workflow.mjs"),
    ...args,
    "--root",
    root,
  ], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
}

async function prepareReceiptFixture(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const simulation = runWorkflow(root, [
    "simulate",
    "--fixture",
    path.join(repositoryRoot, "tests", "fixtures", "workflow", "happy-path.json"),
  ]);
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
  const observedAt = new Date(Date.now() - 5_000).toISOString();
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
    mutationDigest: digestValue({ operation: request.operation, inputs: request.inputs }),
    accountObservation: observation.account,
    targetObservation: observation.target,
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + 120_000).toISOString(),
  };
  const receiptPath = path.join(root, "preflight.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return { root, requestPath, request, observation, receipt, receiptPath };
}

describe("provider-free Issue workflow simulation", { timeout: 20_000 }, () => {
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
    const { root, requestPath, request, observation, receipt, receiptPath } = await prepareReceiptFixture("web-template-receipt-e2e-");
    const resultPath = path.join(root, "result.json");

    const callerClock = runWorkflow(root, [
      "validate-preflight",
      "--file", receiptPath,
      "--request", requestPath,
      "--surface", "github-cli",
      "--now", receipt.observedAt,
    ]);
    expect(callerClock.status).not.toBe(0);
    expect(callerClock.stderr).toMatch(/--now.*not accepted|trusted clock/u);

    const preflight = runWorkflow(root, [
      "validate-preflight",
      "--file", receiptPath,
      "--request", requestPath,
      "--surface", "github-cli",
    ]);
    expect(preflight.status, preflight.stderr).toBe(0);
    expect(JSON.parse(preflight.stdout)).toMatchObject({ ok: true, receiptId: receipt.receiptId });
    expect(preflight.stdout).not.toContain("fixture-user");

    const validatedPath = path.join(root, ".artifacts", "ops-receipts", "receipts", `${receipt.receiptId}.validated.json`);
    expect((await stat(validatedPath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(validatedPath))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root, ".artifacts", "ops-receipts"))).mode & 0o777).toBe(0o700);
    if (typeof process.getuid === "function") {
      expect((await stat(validatedPath)).uid).toBe(process.getuid());
      expect((await stat(path.dirname(validatedPath))).uid).toBe(process.getuid());
    }

    const claimArgs = [
      "claim-execution",
      "--preflight", receiptPath,
      "--request", requestPath,
      "--surface", "github-cli",
    ];
    const claimed = runWorkflow(root, claimArgs);
    expect(claimed.status, claimed.stderr).toBe(0);
    const claim = JSON.parse(claimed.stdout);
    expect(claim).toMatchObject({ ok: true, status: "claimed", mutationDigest: receipt.mutationDigest });
    const claimPath = path.join(
      root,
      ".artifacts",
      "ops-receipts",
      "mutations",
      `${receipt.mutationDigest.slice("sha256:".length)}.claim.json`,
    );
    expect((await stat(claimPath)).mode & 0o777).toBe(0o600);
    const duplicateClaim = runWorkflow(root, claimArgs);
    expect(duplicateClaim.status).not.toBe(0);
    expect(duplicateClaim.stderr).toMatch(/already.*claimed|retry.*forbidden/u);

    const secondReceipt = { ...receipt, receiptId: "receipt-issue-42-github-merge-pr-2" };
    const secondReceiptPath = path.join(root, "preflight-2.json");
    await writeFile(secondReceiptPath, `${JSON.stringify(secondReceipt, null, 2)}\n`, "utf8");
    const secondPreflight = runWorkflow(root, [
      "validate-preflight",
      "--file", secondReceiptPath,
      "--request", requestPath,
      "--surface", "github-cli",
    ]);
    expect(secondPreflight.status, secondPreflight.stderr).toBe(0);
    const secondClaim = runWorkflow(root, [
      "claim-execution",
      "--preflight", secondReceiptPath,
      "--request", requestPath,
      "--surface", "github-cli",
    ]);
    expect(secondClaim.status).not.toBe(0);
    expect(secondClaim.stderr).toMatch(/mutation.*already.*claimed|retry.*forbidden/u);

    const evidence = {
      issue: request.inputs.issue,
      prNumber: request.inputs.prNumber,
      headSha: request.inputs.headSha,
      method: request.inputs.method,
      mergeCommitSha: "7".repeat(40),
      issueClosed: true,
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
        observedAt: new Date(Math.max(Date.now(), Date.parse(claim.startedAt) + 1)).toISOString(),
      },
      outcome: { status: "succeeded", evidence, evidenceDigest: digestValue(evidence) },
    };
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

    const resultArgs = [
      "validate-result",
      "--file", resultPath,
      "--preflight", receiptPath,
      "--request", requestPath,
      "--surface", "github-cli",
    ];
    const validatedResult = runWorkflow(root, resultArgs);
    expect(validatedResult.status, validatedResult.stderr).toBe(0);
    expect(JSON.parse(validatedResult.stdout)).toMatchObject({ ok: true, finalized: true, outcome: "succeeded" });
    expect(validatedResult.stdout).not.toContain("fixture-user");
    const finalizedPath = claimPath.replace(/\.claim\.json$/u, ".finalized.json");
    expect((await stat(finalizedPath)).mode & 0o777).toBe(0o600);

    const reused = runWorkflow(root, resultArgs);
    expect(reused.status).not.toBe(0);
    expect(reused.stderr).toMatch(/finalized|reuse/u);
  });

  it("rejects traversal and a symlinked receipt-state parent without writing outside the repository", async () => {
    const { root, requestPath, receipt, receiptPath } = await prepareReceiptFixture("web-template-receipt-path-");
    const traversalReceipt = { ...receipt, receiptId: "receipt-../../outside" };
    const traversalPath = path.join(root, "traversal.json");
    await writeFile(traversalPath, `${JSON.stringify(traversalReceipt, null, 2)}\n`, "utf8");
    const traversal = runWorkflow(root, [
      "validate-preflight",
      "--file", traversalPath,
      "--request", requestPath,
      "--surface", "github-cli",
    ]);
    expect(traversal.status).not.toBe(0);
    expect(traversal.stderr).toMatch(/receipt|invalid|canonical/u);

    const outside = await mkdtemp(path.join(os.tmpdir(), "web-template-receipt-outside-"));
    const outsideState = path.join(outside, "state.json");
    await writeFile(outsideState, "sentinel\n", "utf8");
    const receiptsDirectory = path.join(root, ".artifacts", "ops-receipts", "receipts");
    await mkdir(receiptsDirectory, { recursive: true });
    await chmod(path.join(root, ".artifacts", "ops-receipts"), 0o700);
    await chmod(receiptsDirectory, 0o700);
    await symlink(outsideState, path.join(receiptsDirectory, `${receipt.receiptId}.validated.json`));
    const finalSymlink = runWorkflow(root, [
      "validate-preflight",
      "--file", receiptPath,
      "--request", requestPath,
      "--surface", "github-cli",
    ]);
    expect(finalSymlink.status).not.toBe(0);
    expect(finalSymlink.stderr).toMatch(/validated|reuse|symbolic link/iu);
    expect(await readFile(outsideState, "utf8")).toBe("sentinel\n");

    await rm(path.join(root, ".artifacts", "ops-receipts"), { recursive: true, force: true });
    await symlink(outside, path.join(root, ".artifacts", "ops-receipts"), "dir");
    const symlinked = runWorkflow(root, [
      "validate-preflight",
      "--file", receiptPath,
      "--request", requestPath,
      "--surface", "github-cli",
    ]);
    expect(symlinked.status).not.toBe(0);
    expect(symlinked.stderr).toMatch(/symbolic link|receipt-state parent/iu);
    expect(await readdir(outside)).toEqual(["state.json"]);
  });

  it("fails closed for an existing receipt-state directory with non-owner permissions", async () => {
    const { root, requestPath, receiptPath } = await prepareReceiptFixture("web-template-receipt-mode-");
    const stateRoot = path.join(root, ".artifacts", "ops-receipts");
    await mkdir(path.join(stateRoot, "receipts"), { recursive: true });
    await chmod(stateRoot, 0o755);
    await chmod(path.join(stateRoot, "receipts"), 0o700);

    const command = runWorkflow(root, [
      "validate-preflight",
      "--file", receiptPath,
      "--request", requestPath,
      "--surface", "github-cli",
    ]);
    expect(command.status).not.toBe(0);
    expect(command.stderr).toMatch(/owner-only|permissions|mode/u);
  });
});
