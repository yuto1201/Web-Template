import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  digestValue,
  loadProtectedAuthority,
  simulateWorkflowFixture,
  snapshotIssueContract,
} from "../tools/workflow-core.mjs";

const fixturePath = path.resolve("tests/fixtures/workflow/happy-path.json");

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

/** @param {string} root @param {string[]} args */
function issueWorkflow(root, args) {
  return spawnSync(process.execPath, [path.resolve("tools/issue-workflow.mjs"), ...args, "--root", root], {
    cwd: path.resolve("."),
    encoding: "utf8",
    windowsHide: true,
  });
}

async function repositoryFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "guarded-provider-"));
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const simulated = await simulateWorkflowFixture(fixture, root);
  const authority = JSON.parse(await readFile(path.join(root, "config", "ownership.json"), "utf8"));
  return { root, simulated, authority };
}

function clock() {
  let milliseconds = Date.parse("2026-08-30T01:00:00Z");
  return () => new Date(milliseconds += 1_000);
}

/** @param {Record<string, any>} authority @param {{switchAtClaim?: boolean, wrongHeadAtClaim?: boolean, idempotency?: string}} [options] */
function githubClient(authority, options = {}) {
  let executions = 0;
  return {
    service: "github",
    surface: "github-cli",
    idempotencyMode: () => options.idempotency ?? "provider-enforced",
    async collectObservation({ phase, request }) {
      return {
        account: { ...authority.accounts.github, ...authority.observations.github },
        target: {
          ...authority.resourceTargets.github,
          ...(phase === "claim" && options.switchAtClaim ? { repositoryId: authority.resourceTargets.github.repositoryId + 1 } : {}),
        },
        operation: {
          repository: `${authority.resourceTargets.github.owner}/${authority.resourceTargets.github.repository}`,
          prNumber: request.inputs.prNumber,
          headSha: phase === "claim" && options.wrongHeadAtClaim ? "9".repeat(40) : request.inputs.headSha,
          method: request.inputs.method,
        },
      };
    },
    async execute({ request, idempotencyKey }) {
      executions += 1;
      if (request.operation === "github.read_issue") {
        return {
          status: "succeeded",
          evidence: { issue: request.inputs.issue, state: "OPEN", updatedAt: "2026-08-30T01:00:30Z" },
          providerIdempotencyKey: idempotencyKey,
        };
      }
      return {
        status: "succeeded",
        evidence: {
          issue: request.inputs.issue,
          prNumber: request.inputs.prNumber,
          headSha: request.inputs.headSha,
          method: request.inputs.method,
          mergeCommitSha: "7".repeat(40),
          issueClosed: true,
        },
        providerIdempotencyKey: idempotencyKey,
      };
    },
    executionCount: () => executions,
  };
}

describe("provider-specific guarded adapters", () => {
  it("collects preflight, claim, and postflight from one provider surface and executes only the frozen mutation", async () => {
    const { createGitHubGuardedAdapter } = await import("../tools/provider-guarded-adapter.mjs");
    const { root, simulated, authority } = await repositoryFixture();
    const client = githubClient(authority);
    const adapter = createGitHubGuardedAdapter({ providerClient: client, clock: clock() });

    const result = await adapter.execute({ root, requestPath: simulated.paths.mergeRequest });

    expect(result).toMatchObject({
      ok: true,
      service: "github",
      operation: "github.merge_pr",
      outcome: "succeeded",
      lifecycle: {
        preflight: { digest: expect.stringMatching(/^sha256:/u) },
        claim: { observationDigest: expect.stringMatching(/^sha256:/u) },
        result: { digest: expect.stringMatching(/^sha256:/u) },
      },
    });
    expect(client.executionCount()).toBe(1);
    expect(JSON.stringify(result)).not.toContain(authority.accounts.github.login);
  });

  it("rejects an account or live PR Head switch immediately before mutation", async () => {
    const { createGitHubGuardedAdapter } = await import("../tools/provider-guarded-adapter.mjs");
    const { root, simulated, authority } = await repositoryFixture();
    const switchedClient = githubClient(authority, { switchAtClaim: true });
    await expect(createGitHubGuardedAdapter({ providerClient: switchedClient, clock: clock() }).execute({
      root,
      requestPath: simulated.paths.mergeRequest,
    })).rejects.toThrow(/account|target switch|identity mismatch/iu);
    expect(switchedClient.executionCount()).toBe(0);

    const wrongHeadRoot = await repositoryFixture();
    const wrongHeadClient = githubClient(wrongHeadRoot.authority, { wrongHeadAtClaim: true });
    await expect(createGitHubGuardedAdapter({ providerClient: wrongHeadClient, clock: clock() }).execute({
      root: wrongHeadRoot.root,
      requestPath: wrongHeadRoot.simulated.paths.mergeRequest,
    })).rejects.toThrow(/live PR Head|frozen.*Head/iu);
    expect(wrongHeadClient.executionCount()).toBe(0);
  });

  it("requires provider-enforced idempotency for writes and shares one-use state across sibling worktrees", async () => {
    const { createGitHubGuardedAdapter } = await import("../tools/provider-guarded-adapter.mjs");
    const fixture = await repositoryFixture();
    const unsupportedClient = githubClient(fixture.authority, { idempotency: "none" });
    await expect(createGitHubGuardedAdapter({ providerClient: unsupportedClient, clock: clock() }).execute({
      root: fixture.root,
      requestPath: fixture.simulated.paths.mergeRequest,
    })).rejects.toThrow(/provider.*idempotency/iu);
    expect(unsupportedClient.executionCount()).toBe(0);

    const sibling = `${fixture.root}-sibling`;
    git(fixture.root, ["worktree", "add", "--detach", sibling, "HEAD"]);
    await mkdir(path.join(sibling, ".artifacts"), { recursive: true });
    await cp(path.join(fixture.root, ".artifacts"), path.join(sibling, ".artifacts"), { recursive: true });
    const firstClient = githubClient(fixture.authority);
    await createGitHubGuardedAdapter({ providerClient: firstClient, clock: clock() }).execute({
      root: fixture.root,
      requestPath: fixture.simulated.paths.mergeRequest,
    });
    const secondClient = githubClient(fixture.authority);
    await expect(createGitHubGuardedAdapter({ providerClient: secondClient, clock: clock() }).execute({
      root: sibling,
      requestPath: fixture.simulated.paths.mergeRequest,
    })).rejects.toThrow(/same mutation|already claimed|terminal/iu);
    expect(secondClient.executionCount()).toBe(0);
  });

  it("does not permanently deduplicate repeated authorized reads", async () => {
    const { createGitHubGuardedAdapter } = await import("../tools/provider-guarded-adapter.mjs");
    const { root, authority } = await repositoryFixture();
    const issue = 42;
    const contract = snapshotIssueContract({
      schemaVersion: 2,
      issue,
      repository: "yuto1201/Web-Template",
      goal: "Read one frozen Issue repeatedly within receipt freshness.",
      acceptanceCriteria: [{ id: "AC-1", text: "The authorized read is repeatable." }],
      dependencies: [],
      externalAuthorizations: [{
        service: "github",
        operation: "github.read_issue",
        purposeCode: "issue-contract",
        purpose: `Read the frozen Issue ${issue}.`,
        accountRef: "accounts.github",
        targetRef: "resourceTargets.github",
        environment: "none",
        constraints: { issue },
        requiresExactHead: false,
      }],
    }, "2026-08-30T00:00:00Z", loadProtectedAuthority(root, "main"));
    const request = {
      schemaVersion: 1,
      requestId: `issue-${issue}-github-read-issue-1`,
      issue,
      operation: "github.read_issue",
      target: { kind: "github.repository", identifier: "resourceTargets.github" },
      environment: "none",
      reasonCode: "issue-contract",
      operatorLabel: "codex",
      executionRole: "external-operator",
      executionSurface: "github-cli",
      inputs: { issue },
    };
    const contractPath = path.join(root, ".artifacts", "issues", String(issue), "issue-contract.json");
    const requestPath = path.join(root, ".artifacts", "ops-requests", request.requestId + ".json");
    await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
    const client = githubClient(authority, { idempotency: "none" });
    const adapter = createGitHubGuardedAdapter({ providerClient: client, clock: clock() });

    await expect(adapter.execute({ root, requestPath })).resolves.toMatchObject({ outcome: "succeeded" });
    await expect(adapter.execute({ root, requestPath })).resolves.toMatchObject({ outcome: "succeeded" });
    expect(client.executionCount()).toBe(2);
  });

  it("rejects caller-authored receipt JSON as an execution-authorizing production path", async () => {
    const { root, simulated, authority } = await repositoryFixture();
    const requestPath = path.join(root, simulated.paths.mergeRequest);
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    const contract = JSON.parse(await readFile(path.join(root, simulated.paths.contract), "utf8"));
    const observedAt = new Date(Date.now() - 1_000).toISOString();
    const receipt = {
      schemaVersion: 1,
      receiptId: "receipt-caller-fabricated",
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
      accountObservation: { ...authority.accounts.github, ...authority.observations.github },
      targetObservation: authority.resourceTargets.github,
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 120_000).toISOString(),
    };
    const receiptPath = path.join(root, "fabricated-receipt.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

    const command = issueWorkflow(root, [
      "validate-preflight",
      "--file", receiptPath,
      "--request", requestPath,
      "--surface", "github-cli",
    ]);
    expect(command.status).not.toBe(0);
    expect(command.stderr).toMatch(/caller-authored|guarded provider adapter|unsupported/iu);
  });
});
