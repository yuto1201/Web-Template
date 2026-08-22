import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectCursorCloudSnapshot,
  evaluateCursorCloud,
  formatCursorCloudReport,
  readActivationEvidence,
  validateActivationEvidence,
} from "../tools/cursor-cloud-doctor.mjs";

/** @typedef {{ build: { dockerfile: string, context: string }, install: string, start: string }} CursorEnvironment */
/**
 * @typedef RepositorySnapshot
 * @property {string[]} policyErrors
 * @property {string} nodeVersion
 * @property {string} nvmVersion
 * @property {string} packageNodeVersion
 * @property {string} packageNpmVersion
 * @property {string} packageManager
 * @property {string} branch
 * @property {string} headSha
 * @property {CursorEnvironment} environment
 * @property {string} dockerfile
 */
/** @typedef {{ node: string, npm: string, docker: boolean, chromium: boolean }} RuntimeSnapshot */
/**
 * @typedef OwnershipSnapshot
 * @property {number} schemaVersion
 * @property {{ owner: string, repository: string }} github
 * @property {{ organizationName: string, projectRef: string }} supabase
 * @property {{ scope: string, projectId: string }} vercel
 * @property {{ accountId: string, accountName: string, zoneId: string, domains: string[] }} cloudflare
 */
/** @typedef {{ cursorModels: { openai: string, anthropic: string } }} ExecutionPolicy */
/**
 * @typedef ReadySnapshot
 * @property {RepositorySnapshot} repository
 * @property {RuntimeSnapshot} runtime
 * @property {OwnershipSnapshot} ownership
 * @property {ExecutionPolicy} executionPolicy
 */
/**
 * @typedef ReadySnapshotOverrides
 * @property {RepositorySnapshot} [repository]
 * @property {RuntimeSnapshot} [runtime]
 * @property {OwnershipSnapshot} [ownership]
 * @property {ExecutionPolicy} [executionPolicy]
 */
/** @typedef {Omit<ReadySnapshot, "repository"> & { repository: Omit<RepositorySnapshot, "branch"> & { branch: null } }} MissingBranchSnapshot */
/** @typedef {Omit<ReadySnapshot, "repository"> & { repository: Omit<RepositorySnapshot, "headSha"> & { headSha: null } }} MissingHeadSnapshot */
/** @typedef {Omit<ReadySnapshot, "ownership"> & { ownership: Omit<OwnershipSnapshot, "supabase"> & { supabase: { organizationName: string, projectRef: null } } }} MissingSupabaseProjectSnapshot */
/** @typedef {ReadySnapshot | MissingBranchSnapshot | MissingHeadSnapshot | MissingSupabaseProjectSnapshot} EvaluationSnapshot */
/**
 * @typedef ReviewerEvidence
 * @property {string} observed
 * @property {string} repositoryReadProbe
 * @property {string} fileProbe
 * @property {string} shellProbe
 * @property {string} providerToolProbe
 * @property {string} completionProbe
 */
/**
 * @typedef ProviderEvidence
 * @property {{ owner: string, fullName: string, status: string }} github
 * @property {{ organizationName: string, projectRef: string, status: string }} supabase
 * @property {{ scope: string, projectId: string, status: string }} vercel
 * @property {{ accountId: string, accountName: string, zoneId: string, domain: string, status: string }} cloudflare
 */
/**
 * @typedef ActivationEvidence
 * @property {number} schemaVersion
 * @property {string} surface
 * @property {{ id: string, modelObserved: string }} run
 * @property {{ fullName: string, branch: string, headSha: string }} repository
 * @property {{ status: string, node: string, npm: string, docker: boolean, chromium: boolean }} build
 * @property {{ openai: ReviewerEvidence, anthropic: ReviewerEvidence }} reviewers
 * @property {ProviderEvidence} providers
 * @property {string} verifiedAt
 */
/** @typedef {{ fullName: string, status: string }} GitHubEvidenceWithoutOwner */
/** @typedef {{ owner: string, fullName: string, status: string, token: string }} GitHubEvidenceWithToken */
/** @typedef {{ id: string, modelObserved: string, note: string }} RunEvidenceWithNote */
/** @typedef {Omit<ProviderEvidence, "github"> & { github: GitHubEvidenceWithoutOwner }} ProviderEvidenceWithoutGitHubOwner */
/** @typedef {Omit<ProviderEvidence, "github"> & { github: GitHubEvidenceWithToken }} ProviderEvidenceWithGitHubToken */
/** @typedef {Omit<ActivationEvidence, "providers"> & { providers: ProviderEvidenceWithoutGitHubOwner }} ActivationEvidenceWithoutGitHubOwner */
/** @typedef {Omit<ActivationEvidence, "run"> & { run: RunEvidenceWithNote }} ActivationEvidenceWithRunNote */
/** @typedef {Omit<ActivationEvidence, "providers"> & { providers: ProviderEvidenceWithGitHubToken }} ActivationEvidenceWithGitHubToken */
/** @typedef {[string, (value: ActivationEvidence) => void]} ActivationMutationCase */
/** @typedef {{ build?: boolean, activation?: ActivationEvidence }} EvaluationOptions */

/** @type {CursorEnvironment} */
const environment = {
  build: { dockerfile: "Dockerfile", context: ".." },
  install: "npm ci && npm exec -- playwright install --with-deps chromium && npm run cursor:doctor -- --build",
  start: "sudo service docker start",
};

const dockerfile = `FROM node:24.13.0-bookworm

RUN apt-get update \\
    && apt-get install -y --no-install-recommends \\
      ca-certificates \\
      curl \\
      docker.io \\
      git \\
      ripgrep \\
    && npm install --global npm@11.6.2 \\
    && rm -rf /var/lib/apt/lists/*
`;

/** @type {OwnershipSnapshot} */
const ownership = {
  schemaVersion: 1,
  github: { owner: "yuto1201", repository: "Web-Template" },
  supabase: { organizationName: "yuto1201's Org", projectRef: "abcdefghijklmnopqrst" },
  vercel: { scope: "team_public", projectId: "prj_public" },
  cloudflare: {
    accountId: "public_account_id",
    accountName: "Yuto Dev",
    zoneId: "public_zone_id",
    domains: ["web-template.yutodev.com"],
  },
};

/** @type {ExecutionPolicy} */
const executionPolicy = {
  cursorModels: {
    openai: "gpt-5.6-sol[effort=high]",
    anthropic: "claude-opus-5[effort=high]",
  },
};

const referenceTime = new Date("2026-08-22T12:05:00+09:00");
const headSha = "a".repeat(40);

/** @type {ActivationEvidence} */
const ready = {
  schemaVersion: 1,
  surface: "cursor-cloud",
  run: { id: "bc-00000000-0000-0000-0000-000000000029", modelObserved: "composer-2.5" },
  repository: { fullName: "yuto1201/Web-Template", branch: "cursor/29-cloud-mode", headSha },
  build: { status: "ready", node: "24.13.0", npm: "11.6.2", docker: true, chromium: true },
  reviewers: {
    openai: {
      observed: "gpt-5.6-sol",
      repositoryReadProbe: "passed",
      fileProbe: "denied",
      shellProbe: "denied",
      providerToolProbe: "denied",
      completionProbe: "passed",
    },
    anthropic: {
      observed: "claude-opus-5",
      repositoryReadProbe: "passed",
      fileProbe: "denied",
      shellProbe: "denied",
      providerToolProbe: "denied",
      completionProbe: "passed",
    },
  },
  providers: {
    github: { owner: "yuto1201", fullName: "yuto1201/Web-Template", status: "verified" },
    supabase: { organizationName: "yuto1201's Org", projectRef: "abcdefghijklmnopqrst", status: "verified" },
    vercel: { scope: "team_public", projectId: "prj_public", status: "verified" },
    cloudflare: {
      accountId: "public_account_id",
      accountName: "Yuto Dev",
      zoneId: "public_zone_id",
      domain: "web-template.yutodev.com",
      status: "verified",
    },
  },
  verifiedAt: "2026-08-22T12:00:00+09:00",
};

/** @param {ReadySnapshotOverrides} [overrides] @returns {ReadySnapshot} */
function readySnapshot(overrides = {}) {
  return {
    repository: {
      policyErrors: [],
      nodeVersion: "24.13.0",
      nvmVersion: "24.13.0",
      packageNodeVersion: "24.13.0",
      packageNpmVersion: "11.6.2",
      packageManager: "npm@11.6.2",
      branch: "cursor/29-cloud-mode",
      headSha,
      environment: structuredClone(environment),
      dockerfile,
    },
    runtime: { node: "24.13.0", npm: "11.6.2", docker: true, chromium: true },
    ownership: structuredClone(ownership),
    executionPolicy: structuredClone(executionPolicy),
    ...overrides,
  };
}

/** @returns {MissingSupabaseProjectSnapshot} */
function snapshotWithoutSupabaseProject() {
  const snapshot = readySnapshot();
  return {
    ...snapshot,
    ownership: {
      ...snapshot.ownership,
      supabase: { ...snapshot.ownership.supabase, projectRef: null },
    },
  };
}

/** @returns {MissingBranchSnapshot} */
function snapshotWithoutBranch() {
  const snapshot = readySnapshot();
  return {
    ...snapshot,
    repository: { ...snapshot.repository, branch: null },
  };
}

/** @returns {MissingHeadSnapshot} */
function snapshotWithoutHead() {
  const snapshot = readySnapshot();
  return {
    ...snapshot,
    repository: { ...snapshot.repository, headSha: null },
  };
}

/** @param {ActivationEvidence} value */
function validateActivation(value) {
  return validateActivationEvidence(value, executionPolicy, { referenceTime });
}

/** @param {EvaluationSnapshot} snapshot @param {EvaluationOptions} [options] */
function evaluate(snapshot, options = {}) {
  return evaluateCursorCloud(snapshot, { ...options, referenceTime });
}

describe("Cursor Cloud doctor", () => {
  it("accepts deterministic repository/build readiness and records the base-image warning", () => {
    const report = evaluate(readySnapshot(), { build: true });

    expect(report.status).toBe("ready");
    expect(report.blockers).toEqual([]);
    expect(report.checks.every((entry) => entry.status === "pass")).toBe(true);
    expect(report.warnings).toEqual(["base-image-not-digest-pinned"]);
  });

  it("fails closed on repository and runtime drift", () => {
    const snapshot = readySnapshot();
    snapshot.repository.policyErrors = ["policy drift"];
    snapshot.repository.nodeVersion = "25.0.0";
    snapshot.runtime.node = "25.0.0";
    snapshot.runtime.npm = "12.0.0";

    const report = evaluate(snapshot, { build: true });

    expect(report.status).toBe("blocked:environment");
    expect(report.blockers).toEqual(expect.arrayContaining([
      "repository-policy-invalid",
      "node-version-mismatch",
      "npm-version-mismatch",
    ]));
  });

  it("names unavailable Docker and Chromium without probing provider credentials", () => {
    const report = evaluate(readySnapshot({
      runtime: { node: "24.13.0", npm: "11.6.2", docker: false, chromium: false },
    }), { build: true });

    expect(report.status).toBe("blocked:environment");
    expect(report.blockers).toEqual(["docker-executable-unavailable", "chromium-executable-unavailable"]);
    expect(JSON.stringify(report)).not.toMatch(/token|credential|\.env/iu);
  });

  it("validates a strict redacted activation fixture", () => {
    expect(validateActivation(ready)).toEqual(ready);
    expect(evaluate(readySnapshot(), { build: true, activation: ready })).toMatchObject({
      status: "ready",
      blockers: [],
    });
  });

  it("rejects missing identities, unexpected fields, and credential-shaped input", () => {
    /** @type {ActivationEvidenceWithoutGitHubOwner} */
    const missingIdentity = {
      ...structuredClone(ready),
      providers: {
        ...structuredClone(ready.providers),
        github: {
          fullName: ready.providers.github.fullName,
          status: ready.providers.github.status,
        },
      },
    };
    expect(() => validateActivationEvidence(
      missingIdentity,
      executionPolicy,
      { referenceTime },
    )).toThrow(/github owner/iu);

    /** @type {ActivationEvidenceWithRunNote} */
    const extra = {
      ...structuredClone(ready),
      run: { ...structuredClone(ready.run), note: "unexpected" },
    };
    expect(() => validateActivationEvidence(
      extra,
      executionPolicy,
      { referenceTime },
    )).toThrow(/unexpected propert/iu);

    /** @type {ActivationEvidenceWithGitHubToken} */
    const secretField = {
      ...structuredClone(ready),
      providers: {
        ...structuredClone(ready.providers),
        github: {
          ...structuredClone(ready.providers.github),
          token: ["ghp", "_123456789012345678901234567890"].join(""),
        },
      },
    };
    expect(() => validateActivationEvidence(
      secretField,
      executionPolicy,
      { referenceTime },
    )).toThrow(/secret-shaped/iu);

    const secretValue = structuredClone(ready);
    secretValue.providers.github.owner = ["ghp", "_123456789012345678901234567890"].join("");
    expect(() => validateActivation(secretValue)).toThrow(/secret-shaped/iu);
  });

  it("rejects wrong surfaces, branches, timestamps, models, and reviewer capabilities", () => {
    /** @type {ActivationMutationCase[]} */
    const mutations = [
      ["surface", (value) => { value.surface = "codex-local"; }],
      ["branch", (value) => { value.repository.branch = "codex/29-cloud-mode"; }],
      ["timestamp", (value) => { value.verifiedAt = "2026-08-22"; }],
      ["calendar timestamp", (value) => { value.verifiedAt = "2026-02-30T12:00:00+09:00"; }],
      ["parent model", (value) => { value.run.modelObserved = "unknown"; }],
      ["reviewer model", (value) => { value.reviewers.openai.observed = "unknown"; }],
      ["fallback model", (value) => { value.reviewers.openai.observed = "claude-opus-5"; }],
      ["repository-read probe", (value) => { value.reviewers.anthropic.repositoryReadProbe = "failed"; }],
      ["file probe", (value) => { value.reviewers.openai.fileProbe = "allowed"; }],
      ["shell probe", (value) => { value.reviewers.anthropic.shellProbe = "allowed"; }],
      ["provider-tool probe", (value) => { value.reviewers.openai.providerToolProbe = "allowed"; }],
      ["completion probe", (value) => { value.reviewers.anthropic.completionProbe = "failed"; }],
    ];

    for (const [label, mutate] of mutations) {
      const value = structuredClone(ready);
      mutate(value);
      expect(() => validateActivation(value), label).toThrow();
    }
  });

  it("rejects runtime drift and any non-ready Build state", () => {
    /** @type {Array<(value: ActivationEvidence) => void>} */
    const mutations = [
      (value) => { value.build.status = "blocked"; },
      (value) => { value.build.node = "25.0.0"; },
      (value) => { value.build.npm = "12.0.0"; },
      (value) => { value.build.docker = false; },
      (value) => { value.build.chromium = false; },
    ];

    for (const mutate of mutations) {
      const value = structuredClone(ready);
      mutate(value);
      expect(() => validateActivation(value)).toThrow();
    }
  });

  it("rejects same-family fallback models that differ from trusted configured selectors", () => {
    const fallbackOpenAI = structuredClone(ready);
    fallbackOpenAI.reviewers.openai.observed = "gpt-5.6-luna";
    expect(() => validateActivation(fallbackOpenAI)).toThrow(/configured reviewer model/iu);

    const fallbackAnthropic = structuredClone(ready);
    fallbackAnthropic.reviewers.anthropic.observed = "claude-fable-5";
    expect(() => validateActivation(fallbackAnthropic)).toThrow(/configured reviewer model/iu);

    expect(() => validateActivationEvidence(ready, {}, { referenceTime })).toThrow(/trusted reviewer model/iu);
  });

  it("maps invalid activation surfaces to the repository blocked-state taxonomy", () => {
    /** @type {ActivationMutationCase[]} */
    const cases = [
      ["blocked:review", (value) => { value.reviewers.openai.providerToolProbe = "allowed"; }],
      ["blocked:conflict", (value) => { value.repository.branch = "codex/29-cloud-mode"; }],
      ["blocked:environment", (value) => { value.build.chromium = false; }],
      ["blocked:ops", (value) => { value.providers.github.status = "unknown"; }],
    ];

    for (const [status, mutate] of cases) {
      const value = structuredClone(ready);
      mutate(value);
      expect(evaluate(readySnapshot(), { build: true, activation: value }).status).toBe(status);
    }
  });

  it("blocks activation when observed owners or targets differ from public ownership config", () => {
    const wrongGitHub = structuredClone(ready);
    wrongGitHub.providers.github.owner = "different-owner";
    wrongGitHub.providers.github.fullName = "different-owner/Web-Template";
    const githubReport = evaluate(readySnapshot(), { build: true, activation: wrongGitHub });
    expect(githubReport.status).toBe("blocked:ops");
    expect(githubReport.blockers).toEqual(expect.arrayContaining([
      "github-owner-mismatch",
      "github-target-mismatch",
    ]));

    const wrongProviders = structuredClone(ready);
    wrongProviders.providers.supabase.organizationName = "Different Org";
    wrongProviders.providers.supabase.projectRef = "differentprojectref01";
    wrongProviders.providers.vercel.scope = "different-scope";
    wrongProviders.providers.vercel.projectId = "different-project";
    wrongProviders.providers.cloudflare.accountId = "different-account-id";
    wrongProviders.providers.cloudflare.accountName = "Different Account";
    wrongProviders.providers.cloudflare.zoneId = "different-zone-id";
    wrongProviders.providers.cloudflare.domain = "different.example.com";
    const providerReport = evaluate(readySnapshot(), { build: true, activation: wrongProviders });
    expect(providerReport.status).toBe("blocked:ops");
    expect(providerReport.blockers).toEqual(expect.arrayContaining([
      "supabase-owner-mismatch",
      "supabase-project-mismatch",
      "vercel-scope-mismatch",
      "vercel-project-mismatch",
      "cloudflare-account-id-mismatch",
      "cloudflare-owner-mismatch",
      "cloudflare-zone-mismatch",
      "cloudflare-domain-mismatch",
    ]));
  });

  it("blocks activation when any configured provider target is unavailable", () => {
    const snapshot = snapshotWithoutSupabaseProject();

    const report = evaluate(snapshot, { build: true, activation: ready });

    expect(report.status).toBe("blocked:ops");
    expect(report.blockers).toContain("supabase-project-unconfigured");
  });

  it("binds activation evidence to the exact collected Cursor branch", () => {
    const stale = structuredClone(ready);
    stale.repository.branch = "cursor/999-stale-activation";
    const staleReport = evaluate(readySnapshot(), { build: true, activation: stale });
    expect(staleReport.status).toBe("blocked:conflict");
    expect(staleReport.blockers).toContain("activation-branch-mismatch");

    const unavailableBranchReport = evaluate(snapshotWithoutBranch(), { build: true, activation: ready });
    expect(unavailableBranchReport.status).toBe("blocked:conflict");
    expect(unavailableBranchReport.blockers).toContain("current-branch-unavailable");

    for (const branch of ["codex/29-cursor-cloud-mode", "feature"] ) {
      const report = evaluate(readySnapshot({
        repository: { ...readySnapshot().repository, branch },
      }), { build: true, activation: ready });
      expect(report.status).toBe("blocked:conflict");
      expect(report.blockers).toContain("current-branch-not-cursor");
    }
  });

  it("binds activation evidence to the exact collected Head", () => {
    const stale = structuredClone(ready);
    stale.repository.headSha = "b".repeat(40);

    const report = evaluate(readySnapshot(), { build: true, activation: stale });

    expect(report.status).toBe("blocked:conflict");
    expect(report.blockers).toContain("activation-head-mismatch");

    const unavailable = snapshotWithoutHead();
    expect(evaluate(unavailable, { build: true, activation: ready })).toMatchObject({
      status: "blocked:conflict",
      blockers: expect.arrayContaining(["current-head-unavailable"]),
    });
  });

  it("requires activation evidence to be fresh and not future-dated", () => {
    const oldestAccepted = structuredClone(ready);
    oldestAccepted.verifiedAt = "2026-08-21T12:05:00+09:00";
    expect(validateActivation(oldestAccepted)).toEqual(oldestAccepted);

    const newestAccepted = structuredClone(ready);
    newestAccepted.verifiedAt = "2026-08-22T12:10:00+09:00";
    expect(validateActivation(newestAccepted)).toEqual(newestAccepted);

    const stale = structuredClone(ready);
    stale.verifiedAt = "2026-08-21T12:04:59+09:00";
    expect(() => validateActivation(stale)).toThrow(/fresh/iu);
    expect(evaluate(readySnapshot(), { build: true, activation: stale })).toMatchObject({
      status: "blocked:conflict",
      blockers: expect.arrayContaining(["activation-evidence-invalid"]),
    });

    const future = structuredClone(ready);
    future.verifiedAt = "2026-08-22T12:10:01+09:00";
    expect(() => validateActivation(future)).toThrow(/fresh/iu);
  });

  it("collects only non-secret repository/runtime facts", async () => {
    const marker = "cursor-doctor-must-not-read-this-value";
    process.env.CURSOR_DOCTOR_TEST_SECRET = marker;
    try {
      const snapshot = await collectCursorCloudSnapshot(path.resolve("."));
      const branchResult = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
      const headResult = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
      const expectedBranch = branchResult.status === 0 ? `${branchResult.stdout}`.trim() : null;
      const expectedHead = headResult.status === 0 ? `${headResult.stdout}`.trim() : null;
      expect(JSON.stringify(snapshot)).not.toContain(marker);
      expect(snapshot.repository.environment).toEqual(environment);
      expect(snapshot.repository.dockerfile).toContain("FROM node:24.13.0-bookworm");
      expect(snapshot.repository.branch).toBe(expectedBranch);
      expect(snapshot.repository.headSha).toBe(expectedHead);
      expect(snapshot.ownership.github).toEqual({ owner: "yuto1201", repository: "Web-Template" });
      expect(snapshot.executionPolicy.cursorModels).toEqual(executionPolicy.cursorModels);
    } finally {
      delete process.env.CURSOR_DOCTOR_TEST_SECRET;
    }
  });

  it("collects the target root branch instead of the ambient repository branch", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "cursor-cloud-branch-root-"));
    const sourceRoot = path.resolve(".");
    const targetRoot = path.join(temporary, "target");
    const ambientRoot = path.join(temporary, "ambient");
    const originalCwd = process.cwd();
    const excluded = new Set([".git", ".next", ".artifacts", "node_modules", "playwright-report", "test-results"]);
    try {
      await cp(sourceRoot, targetRoot, {
        recursive: true,
        filter(source) {
          const relative = path.relative(sourceRoot, source);
          return relative === "" || !excluded.has(relative.split(path.sep)[0]);
        },
      });
      await mkdir(ambientRoot);
      expect(spawnSync("git", ["init", "--initial-branch=cursor/777-target"], {
        cwd: targetRoot,
        encoding: "utf8",
      }).status).toBe(0);
      expect(spawnSync("git", ["init", "--initial-branch=cursor/888-ambient"], {
        cwd: ambientRoot,
        encoding: "utf8",
      }).status).toBe(0);
      await writeFile(path.join(targetRoot, "target-marker.txt"), "target\n", "utf8");
      await writeFile(path.join(ambientRoot, "ambient-marker.txt"), "ambient\n", "utf8");
      for (const fixtureRoot of [targetRoot, ambientRoot]) {
        expect(spawnSync("git", ["add", "."], { cwd: fixtureRoot, encoding: "utf8" }).status).toBe(0);
        expect(spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], {
          cwd: fixtureRoot,
          encoding: "utf8",
        }).status).toBe(0);
      }

      process.chdir(ambientRoot);
      const snapshot = await collectCursorCloudSnapshot(targetRoot);
      const expectedHead = `${spawnSync("git", ["rev-parse", "HEAD"], { cwd: targetRoot, encoding: "utf8" }).stdout}`.trim();
      const ambientHead = `${spawnSync("git", ["rev-parse", "HEAD"], { cwd: ambientRoot, encoding: "utf8" }).stdout}`.trim();

      expect(snapshot.repository.branch).toBe("cursor/777-target");
      expect(snapshot.repository.branch).not.toBe("cursor/888-ambient");
      expect(snapshot.repository.headSha).toBe(expectedHead);
      expect(snapshot.repository.headSha).not.toBe(ambientHead);
    } finally {
      process.chdir(originalCwd);
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("formats activation output without rendering activation evidence values", () => {
    const report = evaluate(readySnapshot(), { build: true, activation: ready });
    const output = formatCursorCloudReport(report, readySnapshot().ownership, true);

    expect(output).toContain("Status: ready");
    expect(output).toContain("Public config IDs:");
    expect(output).toContain("prj_public");
    expect(output).not.toContain(ready.run.id);
    expect(output).not.toContain(ready.verifiedAt);
    expect(output).not.toContain(ready.reviewers.openai.observed);
  });

  it("reads activation evidence only from a regular JSON file in the redacted artifact directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-cloud-activation-"));
    const artifactDirectory = path.join(root, ".artifacts", "cursor");
    try {
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(path.join(artifactDirectory, `${ready.run.id}.json`), `${JSON.stringify(ready)}\n`, "utf8");
      await writeFile(path.join(artifactDirectory, "activation.json"), `${JSON.stringify(ready)}\n`, "utf8");
      await writeFile(path.join(root, ".env.local"), "PROVIDER_TOKEN=must-not-be-read\n", "utf8");
      await symlink(path.join(root, ".env.local"), path.join(artifactDirectory, "linked.json"));

      await expect(readActivationEvidence(root, `.artifacts/cursor/${ready.run.id}.json`, executionPolicy, { referenceTime })).resolves.toEqual(ready);
      await expect(readActivationEvidence(root, ".artifacts/cursor/activation.json", executionPolicy, { referenceTime })).rejects.toThrow(/run ID/iu);
      await expect(readActivationEvidence(root, ".env.local", executionPolicy)).rejects.toThrow(/redacted artifact directory/iu);
      await expect(readActivationEvidence(root, ".artifacts/cursor/linked.json", executionPolicy)).rejects.toThrow(/regular file/iu);
      await expect(readActivationEvidence(root, ".artifacts/cursor/../activation.json", executionPolicy)).rejects.toThrow(/redacted artifact directory/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not echo an unknown CLI argument that could contain a credential", () => {
    const marker = ["ghp", "_123456789012345678901234567890"].join("");
    const result = spawnSync(process.execPath, ["tools/cursor-cloud-doctor.mjs", `--${marker}`], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown Cursor Cloud doctor option.");
    expect(`${result.stdout}${result.stderr}`).not.toContain(marker);
  });

  it("maps malformed secret-bearing repository JSON to a fixed safe runtime error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-cloud-malformed-"));
    const marker = ["ghp", "_123456789012345678901234567890"].join("");
    try {
      await writeFile(path.join(root, "package.json"), `{"name":"fixture","broken":${marker}}\n`, "utf8");
      const result = spawnSync(process.execPath, [path.resolve("tools/cursor-cloud-doctor.mjs"), "--build"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toBe("cursor-doctor-runtime-failure\n");
      expect(`${result.stdout}${result.stderr}`).not.toContain(marker);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
