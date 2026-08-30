import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createGitHubCliProviderClient } from "../tools/github-cli-provider-client.mjs";
import { executeRegisteredProviderOperation, validateLiveOperationObservation } from "../tools/provider-guarded-adapter.mjs";
import {
  digestValue,
  loadProtectedAuthority,
  simulateWorkflowFixture,
  snapshotIssueContract,
} from "../tools/workflow-core.mjs";

const fixturePath = path.resolve("tests/fixtures/workflow/happy-path.json");

vi.mock("../tools/github-cli-provider-client.mjs", async (importOriginal) => {
  const actual = /** @type {typeof import("../tools/github-cli-provider-client.mjs")} */ (await importOriginal());
  return { ...actual, createGitHubCliProviderClient: vi.fn(actual.createGitHubCliProviderClient) };
});

/** @param {{providerClient: Record<string, any>, clock?: () => Date}} configuration */
function createTestGitHubGuardedAdapter(configuration) {
  vi.mocked(createGitHubCliProviderClient).mockReturnValue(
    /** @type {ReturnType<typeof createGitHubCliProviderClient>} */ (configuration.providerClient),
  );
  return {
    /** @param {{root:string,requestPath:string,modelFamily?:"gpt"|"claude"|"cursor"|"xai"}} input */
    execute(input) {
      return executeRegisteredProviderOperation({
        service: "github",
        root: input.root,
        requestPath: input.requestPath,
        modelFamily: input.modelFamily ?? "gpt",
        ...(configuration.clock ? { clock: configuration.clock } : {}),
      });
    },
  };
}

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
    /** @param {{phase: string, request: Record<string, any>}} input */
    async collectObservation({ phase, request }) {
      return {
        account: { ...authority.accounts.github, ...authority.observations.github },
        target: {
          ...authority.resourceTargets.github,
          ...(phase === "claim" && options.switchAtClaim ? { repositoryId: authority.resourceTargets.github.repositoryId + 1 } : {}),
        },
        operation: request.operation === "github.read_issue"
          ? { repository: `${authority.resourceTargets.github.owner}/${authority.resourceTargets.github.repository}`, issue: request.inputs.issue }
          : {
              repository: `${authority.resourceTargets.github.owner}/${authority.resourceTargets.github.repository}`,
              prNumber: request.inputs.prNumber,
              baseBranch: request.inputs.baseBranch,
              headSha: phase === "claim" && options.wrongHeadAtClaim ? "9".repeat(40) : request.inputs.headSha,
              method: request.inputs.method,
            },
      };
    },
    /** @param {{request: Record<string, any>, idempotencyKey: string}} input */
    async execute({ request, idempotencyKey }) {
      executions += 1;
      if (request.operation === "github.read_issue") {
        return {
          status: "succeeded",
          evidence: { repository: request.inputs.repository, issue: request.inputs.issue, state: "OPEN", updatedAt: "2026-08-30T01:00:30Z" },
          providerIdempotencyKey: idempotencyKey,
        };
      }
      return {
        status: "succeeded",
        evidence: {
          issue: request.inputs.issue,
          repository: request.inputs.repository,
          prNumber: request.inputs.prNumber,
          baseBranch: request.inputs.baseBranch,
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
  it("uses the production GitHub CLI client without switching accounts and binds the merge SHA", async () => {
    const { createGitHubCliProviderClient: createActualGitHubClient } = /** @type {typeof import("../tools/github-cli-provider-client.mjs")} */ (
      await vi.importActual("../tools/github-cli-provider-client.mjs")
    );
    const authority = JSON.parse(await readFile(path.resolve("config/ownership.json"), "utf8"));
    /** @type {string[][]} */
    const calls = [];
    const request = {
      operation: "github.merge_pr",
      inputs: { issue: 33, repository: "yuto1201/Web-Template", prNumber: 44, baseBranch: "main", headSha: "a".repeat(40), method: "squash" },
    };
    const client = createActualGitHubClient({
      now: () => new Date("2026-08-30T01:00:00Z"),
      /** @param {string[]} args */
      invoke(args) {
        calls.push(args);
        const joined = args.join(" ");
        if (joined === "api user") return { login: authority.accounts.github.login, id: authority.accounts.github.userId, node_id: authority.accounts.github.nodeId, name: "Yuuuuuuuto", created_at: "2019-05-14T00:00:00Z", public_repos: 9 };
        if (joined === "api repos/yuto1201/Web-Template") return { owner: { login: "yuto1201" }, name: "Web-Template", id: authority.resourceTargets.github.repositoryId, node_id: authority.resourceTargets.github.repositoryNodeId };
        if (joined === "api repos/yuto1201/Web-Template/pulls/44") return { number: 44, base: { ref: "main" }, head: { sha: request.inputs.headSha } };
        if (joined.includes("--method PUT") && joined.includes(`sha=${request.inputs.headSha}`)) return { merged: true, sha: "b".repeat(40) };
        if (joined === "api repos/yuto1201/Web-Template/issues/33") return { state: "closed", updated_at: "2026-08-30T01:00:10Z" };
        throw new Error(`Unexpected fake GitHub call: ${joined}`);
      },
    });

    await expect(client.collectObservation({ request })).resolves.toMatchObject({ operation: { baseBranch: "main", headSha: request.inputs.headSha } });
    await expect(client.execute({ request, operation: request.operation })).resolves.toMatchObject({
      status: "succeeded",
      evidence: { mergeCommitSha: "b".repeat(40), issueClosed: true },
    });
    expect(calls.flat()).not.toContain("auth");
    expect(calls.flat()).not.toContain("login");
  });

  it("refuses to merge a pull request whose live base is not protected main", async () => {
    const { createGitHubCliProviderClient: createActualGitHubClient } = /** @type {typeof import("../tools/github-cli-provider-client.mjs")} */ (
      await vi.importActual("../tools/github-cli-provider-client.mjs")
    );
    const authority = JSON.parse(await readFile(path.resolve("config/ownership.json"), "utf8"));
    const request = {
      operation: "github.merge_pr",
      inputs: { issue: 33, repository: "yuto1201/Web-Template", prNumber: 44, baseBranch: "main", headSha: "a".repeat(40), method: "squash" },
    };
    const client = createActualGitHubClient({
      invoke(args) {
        const joined = args.join(" ");
        if (joined === "api user") return { login: authority.accounts.github.login, id: authority.accounts.github.userId, node_id: authority.accounts.github.nodeId, created_at: "2019-05-14T00:00:00Z", public_repos: 9 };
        if (joined === "api repos/yuto1201/Web-Template") return { owner: { login: "yuto1201" }, name: "Web-Template", id: authority.resourceTargets.github.repositoryId, node_id: authority.resourceTargets.github.repositoryNodeId };
        if (joined === "api repos/yuto1201/Web-Template/pulls/44") return { number: 44, base: { ref: "unprotected-target" }, head: { sha: request.inputs.headSha } };
        throw new Error(`Unexpected fake GitHub call: ${joined}`);
      },
    });

    const observation = await client.collectObservation({ request });
    expect(() => validateLiveOperationObservation(request.operation, request, observation.operation, "claim")).toThrow(/base.?branch/iu);
    await expect(client.execute({ request, operation: request.operation })).rejects.toThrow(/base branch/iu);
  });

  it("returns terminal ambiguous evidence when the merge succeeded before Issue closure is observed", async () => {
    const { createGitHubCliProviderClient: createActualGitHubClient } = /** @type {typeof import("../tools/github-cli-provider-client.mjs")} */ (
      await vi.importActual("../tools/github-cli-provider-client.mjs")
    );
    const authority = JSON.parse(await readFile(path.resolve("config/ownership.json"), "utf8"));
    const request = {
      operation: "github.merge_pr",
      inputs: { issue: 33, repository: "yuto1201/Web-Template", prNumber: 44, baseBranch: "main", headSha: "a".repeat(40), method: "squash" },
    };
    const client = createActualGitHubClient({
      invoke(args) {
        const joined = args.join(" ");
        if (joined === "api repos/yuto1201/Web-Template/pulls/44") return { number: 44, base: { ref: "main" }, head: { sha: request.inputs.headSha } };
        if (joined.includes("--method PUT")) return { merged: true, sha: "b".repeat(40) };
        if (joined === "api repos/yuto1201/Web-Template/issues/33") return { state: "open" };
        if (joined === "api user") return { login: authority.accounts.github.login };
        if (joined === "api repos/yuto1201/Web-Template") return { owner: { login: "yuto1201" }, name: "Web-Template" };
        throw new Error(`Unexpected fake GitHub call: ${joined}`);
      },
    });

    await expect(client.execute({ request, operation: request.operation })).resolves.toMatchObject({
      status: "ambiguous",
      retryPolicy: "inspect-provider-state-only",
      evidence: { reasonCode: "MERGE_SUCCEEDED_ISSUE_NOT_CLOSED", providerState: "unknown" },
    });
  });

  it("collects preflight, claim, and postflight from one provider surface and executes only the frozen mutation", async () => {
    const { root, simulated, authority } = await repositoryFixture();
    const client = githubClient(authority);
    const adapter = createTestGitHubGuardedAdapter({ providerClient: client, clock: clock() });

    const result = await adapter.execute({ root, requestPath: simulated.paths.mergeRequest, modelFamily: "gpt" });

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
    expect(result).toMatchObject({
      evidence: {
        executionHeadSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
        references: {
          request: expect.stringMatching(/^evidence\/external-operations\/.+\/request\.json$/u),
          preflight: expect.stringMatching(/^evidence\/external-operations\/.+\/preflight\.json$/u),
          claim: expect.stringMatching(/^evidence\/external-operations\/.+\/claim\.json$/u),
          mutation: expect.stringMatching(/^evidence\/external-operations\/.+\/mutation\.json$/u),
          result: expect.stringMatching(/^evidence\/external-operations\/.+\/result\.json$/u),
          finalized: expect.stringMatching(/^evidence\/external-operations\/.+\/finalized\.json$/u),
        },
      },
    });
    if (!result.evidence) throw new Error("Expected write lifecycle evidence.");
    for (const reference of Object.values(result.evidence.references)) {
      await expect(readFile(path.join(root, reference), "utf8")).resolves.toMatch(/"phase"/u);
    }
    git(root, ["add", "--", ...Object.values(result.evidence.references)]);
    git(root, ["commit", "-m", "test: bind lifecycle evidence"]);
    const { bindExternalOperationEvidence } = await import("../tools/workflow-core.mjs");
    expect(bindExternalOperationEvidence(root, path.posix.dirname(result.evidence.references.request))).toMatchObject({
      executionHeadSha: result.evidence.executionHeadSha,
      evidenceHeadSha: git(root, ["rev-parse", "HEAD"]),
      mutationDigest: expect.stringMatching(/^sha256:/u),
      outcome: "succeeded",
    });
  }, 15_000);

  it("keeps Cursor activation reachable while using the fixed GitHub provider surface", async () => {
    const { root, simulated, authority } = await repositoryFixture();
    const requestPath = path.join(root, simulated.paths.mergeRequest);
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    request.executionSurface = "cursor-cloud";
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
    const client = githubClient(authority);

    await expect(createTestGitHubGuardedAdapter({ providerClient: client, clock: clock() }).execute({
      root,
      requestPath,
      modelFamily: "cursor",
    })).rejects.toThrow(/Cursor Cloud.*activation evidence/iu);
    expect(client.executionCount()).toBe(0);
  }, 15_000);

  it("rejects an account or live PR Head switch immediately before mutation", async () => {
    const { root, simulated, authority } = await repositoryFixture();
    const switchedClient = githubClient(authority, { switchAtClaim: true });
    await expect(createTestGitHubGuardedAdapter({ providerClient: switchedClient, clock: clock() }).execute({
      root,
      requestPath: simulated.paths.mergeRequest,
      modelFamily: "gpt",
    })).rejects.toThrow(/account|target switch|identity mismatch/iu);
    expect(switchedClient.executionCount()).toBe(0);

    const wrongHeadRoot = await repositoryFixture();
    const wrongHeadClient = githubClient(wrongHeadRoot.authority, { wrongHeadAtClaim: true });
    await expect(createTestGitHubGuardedAdapter({ providerClient: wrongHeadClient, clock: clock() }).execute({
      root: wrongHeadRoot.root,
      requestPath: wrongHeadRoot.simulated.paths.mergeRequest,
      modelFamily: "gpt",
    })).rejects.toThrow(/live (?:PR )?Head|frozen.*Head/iu);
    expect(wrongHeadClient.executionCount()).toBe(0);
  }, 15_000);

  it("requires provider-enforced idempotency for writes and shares one-use state across sibling worktrees", async () => {
    const fixture = await repositoryFixture();
    const unsupportedClient = githubClient(fixture.authority, { idempotency: "none" });
    await expect(createTestGitHubGuardedAdapter({ providerClient: unsupportedClient, clock: clock() }).execute({
      root: fixture.root,
      requestPath: fixture.simulated.paths.mergeRequest,
      modelFamily: "gpt",
    })).rejects.toThrow(/provider.*idempotency/iu);
    expect(unsupportedClient.executionCount()).toBe(0);

    const sibling = `${fixture.root}-sibling`;
    git(fixture.root, ["worktree", "add", "-b", "codex/42-sibling", sibling, "HEAD"]);
    await mkdir(path.join(sibling, ".artifacts"), { recursive: true });
    await cp(path.join(fixture.root, ".artifacts"), path.join(sibling, ".artifacts"), { recursive: true });
    const firstClient = githubClient(fixture.authority);
    await createTestGitHubGuardedAdapter({ providerClient: firstClient, clock: clock() }).execute({
      root: fixture.root,
      requestPath: fixture.simulated.paths.mergeRequest,
      modelFamily: "gpt",
    });
    const secondClient = githubClient(fixture.authority);
    await expect(createTestGitHubGuardedAdapter({ providerClient: secondClient, clock: clock() }).execute({
      root: sibling,
      requestPath: fixture.simulated.paths.mergeRequest,
      modelFamily: "gpt",
    })).rejects.toThrow(/same mutation|already claimed|terminal/iu);
    expect(secondClient.executionCount()).toBe(0);
  });

  it("does not permanently deduplicate repeated authorized reads", async () => {
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
        constraints: { repository: "yuto1201/Web-Template", issue },
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
      executionSurface: "codex-local",
      providerSurface: "github-cli",
      intent: `Read Issue ${issue} from the frozen repository target.`,
      reversibility: "read-only",
      recovery: { strategy: "none", instructions: "No mutation is performed; repeat only while the authorization remains fresh." },
      inputs: { repository: "yuto1201/Web-Template", issue },
    };
    const contractPath = path.join(root, ".artifacts", "issues", String(issue), "issue-contract.json");
    const requestPath = path.join(root, ".artifacts", "ops-requests", request.requestId + ".json");
    await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
    const client = githubClient(authority, { idempotency: "none" });
    const adapter = createTestGitHubGuardedAdapter({ providerClient: client, clock: clock() });

    await expect(adapter.execute({ root, requestPath })).resolves.toMatchObject({ outcome: "succeeded" });
    await expect(adapter.execute({ root, requestPath })).resolves.toMatchObject({ outcome: "succeeded" });
    expect(client.executionCount()).toBe(2);
  });

  it("rejects a changed live Supabase migration content digest before mutation", async () => {
    const { validateLiveOperationObservation } = await import("../tools/provider-guarded-adapter.mjs");
    const request = {
      inputs: {
        projectRef: "abcdefghijklmnopqrst",
        migrations: [{
          name: "supabase/migrations/20260830010101_create_receipts.sql",
          contentDigest: `sha256:${"4".repeat(64)}`,
        }],
      },
    };
    expect(() => validateLiveOperationObservation("supabase.apply_migrations", request, {
      projectRef: request.inputs.projectRef,
      migrations: [{ ...request.inputs.migrations[0], contentDigest: `sha256:${"9".repeat(64)}` }],
    }, "postflight-success")).toThrow(/migration content digest|frozen.*binding/iu);
  });

  it("allows a legitimate pre-mutation provider state and requires desired state only after success", async () => {
    const { validateLiveOperationObservation } = await import("../tools/provider-guarded-adapter.mjs");
    const request = {
      inputs: {
        zoneId: "a".repeat(32),
        hostname: "app.example.test",
        recordType: "CNAME",
        target: "new.vercel-dns.com",
        proxied: false,
        routingSource: { provider: "vercel", projectId: "prj_Test123", recommendationDigest: `sha256:${"4".repeat(64)}` },
      },
    };
    const current = { ...request.inputs, target: "old.vercel-dns.com", proxied: true };
    expect(() => validateLiveOperationObservation("cloudflare.upsert_dns", request, current, "claim")).not.toThrow();
    expect(() => validateLiveOperationObservation("cloudflare.upsert_dns", request, current, "postflight-terminal")).not.toThrow();
    expect(() => validateLiveOperationObservation("cloudflare.upsert_dns", request, current, "postflight-success")).toThrow(/target|proxied|postflight/iu);
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
      providerSurface: request.providerSurface,
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

  it("exports no injectable provider-adapter factory to a normal process", () => {
    const command = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `import(${JSON.stringify(pathToFileURL(path.resolve("tools/provider-guarded-adapter.mjs")).href)}).then((module) => {
         const actual = Object.keys(module).sort();
         const expected = ["executeRegisteredProviderOperation", "validateLiveOperationObservation"];
         if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exitCode = 2;
       });`,
    ], {
      cwd: path.resolve("."),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, VITEST: "true" },
    });
    expect(command.status).toBe(0);
  });

  it("fails closed for every provider without a production client", async () => {
    for (const service of /** @type {const} */ (["supabase", "vercel", "cloudflare"])) {
      await expect(executeRegisteredProviderOperation({
        service,
        root: path.resolve("."),
        requestPath: "caller-authored.json",
        modelFamily: "gpt",
      })).rejects.toThrow(/No registered production provider client.*fails closed/iu);
    }
  });
});
