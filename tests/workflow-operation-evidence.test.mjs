import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadProtectedAuthority,
  snapshotIssueContract,
  validateExternalOperationRequest,
} from "../tools/workflow-core.mjs";

const issue = 5;
const runId = "bc-00000000-0000-0000-0000-000000000005";

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cursor-v2-authority-"));
  await mkdir(path.join(root, "config"), { recursive: true });
  const authority = JSON.parse(await readFile(path.resolve("config/ownership.json"), "utf8"));
  authority.resourceTargets.supabase.projectRef = "abcdefghijklmnopqrst";
  await writeFile(path.join(root, "config", "ownership.json"), `${JSON.stringify(authority, null, 2)}\n`, "utf8");
  await copyFile(path.resolve("config/execution.json"), path.join(root, "config", "execution.json"));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Cursor V2 Fixture"]);
  git(root, ["config", "user.email", "cursor-v2@example.invalid"]);
  git(root, ["add", "config"]);
  git(root, ["commit", "-m", "protected authority"]);
  const protectedAuthority = loadProtectedAuthority(root, "main");
  const contract = snapshotIssueContract({
    schemaVersion: 2,
    issue,
    repository: "yuto1201/Web-Template",
    goal: "Validate Cursor against account-bound authority.",
    acceptanceCriteria: [{ id: "AC-1", text: "Every surface uses the protected personal account." }],
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
  }, new Date().toISOString(), protectedAuthority);
  git(root, ["switch", "-c", "cursor/5-evidence"]);
  const headSha = git(root, ["rev-parse", "HEAD"]);
  await mkdir(path.join(root, ".artifacts", "cursor"), { recursive: true });
  const activation = {
    schemaVersion: 1,
    surface: "cursor-cloud",
    run: { id: runId, modelObserved: "composer-2.5" },
    repository: { fullName: "yuto1201/Web-Template", branch: "cursor/5-evidence", headSha },
    build: { status: "ready", node: "24.13.0", npm: "11.6.2", docker: true, chromium: true },
    reviewers: {
      openai: { observed: "gpt-5.6-sol", repositoryReadProbe: "passed", fileProbe: "denied", shellProbe: "denied", providerToolProbe: "denied", completionProbe: "passed" },
      anthropic: { observed: "claude-opus-5", repositoryReadProbe: "passed", fileProbe: "denied", shellProbe: "denied", providerToolProbe: "denied", completionProbe: "passed" },
    },
    providers: {
      github: { owner: authority.resourceTargets.github.owner, fullName: "yuto1201/Web-Template", status: "verified" },
      supabase: { organizationName: authority.accounts.supabase.organizationName, projectRef: authority.resourceTargets.supabase.projectRef, status: "verified" },
      vercel: { scope: authority.accounts.vercel.teamId, projectId: authority.resourceTargets.vercel.projectId, status: "verified" },
      cloudflare: {
        accountId: authority.accounts.cloudflare.accountId,
        accountName: authority.accounts.cloudflare.accountName,
        zoneId: authority.resourceTargets.cloudflare.zoneId,
        domain: authority.resourceTargets.cloudflare.domains[0],
        status: "verified",
      },
    },
    verifiedAt: new Date().toISOString(),
  };
  const activationPath = path.join(root, ".artifacts", "cursor", `${runId}.json`);
  await writeFile(activationPath, `${JSON.stringify(activation, null, 2)}\n`, "utf8");
  return { root, contract, activation, activationPath };
}

/** @param {string} executionSurface @param {{runId:string,activationEvidenceRef:string}} [surfaceContext] */
function request(executionSurface, surfaceContext) {
  return {
    schemaVersion: 1,
    requestId: "issue-5-github-read-issue-1",
    issue,
    operation: "github.read_issue",
    target: { kind: "github.repository", identifier: "resourceTargets.github" },
    environment: "none",
    reasonCode: "issue-contract",
    operatorLabel: "codex",
    executionRole: "implementer",
    executionSurface,
    providerSurface: "github-cli",
    ...(surfaceContext === undefined ? {} : { surfaceContext }),
    intent: "Read the frozen Issue from the protected personal repository.",
    reversibility: "read-only",
    recovery: { strategy: "none", instructions: "No mutation is performed." },
    inputs: { repository: "yuto1201/Web-Template", issue },
  };
}

describe("surface-aware v2 external operation evidence", () => {
  it("gives Claude and Codex equal account-bound local authority", async () => {
    const { root, contract } = await fixture();
    for (const surface of ["codex-local", "claude-local"]) {
      expect(validateExternalOperationRequest(request(surface), root, contract)).toMatchObject({
        operatorLabel: "codex",
        executionSurface: surface,
        resolvedTarget: "yuto1201/Web-Template",
        surfaceActivationDigest: null,
      });
    }
  });

  it("accepts Cursor only with fresh run-bound activation matching protected authority", async () => {
    const { root, contract } = await fixture();
    const validated = validateExternalOperationRequest(request("cursor-cloud", {
      runId,
      activationEvidenceRef: `.artifacts/cursor/${runId}.json`,
    }), root, contract);
    expect(validated.surfaceActivationDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(validated.resolvedTarget).toBe("yuto1201/Web-Template");
  });

  it("fails closed on missing, noncanonical, or mismatched Cursor activation", async () => {
    const { root, contract, activation, activationPath } = await fixture();
    expect(() => validateExternalOperationRequest(request("cursor-cloud"), root, contract)).toThrow(/run-bound activation/u);
    expect(() => validateExternalOperationRequest(request("cursor-cloud", {
      runId,
      activationEvidenceRef: ".artifacts/cursor/activation.json",
    }), root, contract)).toThrow(/activationEvidenceRef|invalid input/iu);
    await writeFile(activationPath, `${JSON.stringify({
      ...activation,
      providers: {
        ...activation.providers,
        github: { ...activation.providers.github, owner: "company-account" },
      },
    }, null, 2)}\n`, "utf8");
    expect(() => validateExternalOperationRequest(request("cursor-cloud", {
      runId,
      activationEvidenceRef: `.artifacts/cursor/${runId}.json`,
    }), root, contract)).toThrow(/github-owner-mismatch/u);
  });
});
