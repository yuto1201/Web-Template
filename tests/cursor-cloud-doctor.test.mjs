import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

const ownership = {
  schemaVersion: 1,
  github: { owner: "yuto1201", repository: "Web-Template" },
  supabase: { organizationName: "yuto1201's Org", projectRef: null },
  vercel: { scope: "team_public", projectId: "prj_public" },
  cloudflare: {
    accountId: "public_account_id",
    accountName: "Yuto Dev",
    zoneId: "public_zone_id",
    domains: ["web-template.yutodev.com"],
  },
};

const executionPolicy = {
  cursorModels: {
    openai: "gpt-5.6-sol[effort=high]",
    anthropic: "claude-opus-5[effort=high]",
  },
};

const ready = {
  schemaVersion: 1,
  surface: "cursor-cloud",
  run: { id: "bc-00000000-0000-0000-0000-000000000029", modelObserved: "composer-2.5" },
  repository: { fullName: "yuto1201/Web-Template", branch: "cursor/29-cloud-mode" },
  build: { status: "ready", node: "24.13.0", npm: "11.6.2", docker: true, chromium: true },
  reviewers: {
    openai: { observed: "gpt-5.6-sol", readonlyProbe: "passed", providerToolProbe: "denied" },
    anthropic: { observed: "claude-opus-5", readonlyProbe: "passed", providerToolProbe: "denied" },
  },
  providers: {
    github: { owner: "yuto1201", target: "yuto1201/Web-Template", status: "verified" },
    supabase: { owner: "yuto1201's Org", targetSource: "config/ownership.json", status: "verified" },
    vercel: { ownerSource: "config/ownership.json", targetSource: "config/ownership.json", status: "verified" },
    cloudflare: { owner: "Yuto Dev", targetSource: "config/ownership.json", status: "verified" },
  },
  verifiedAt: "2026-08-22T12:00:00+09:00",
};

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
      environment: structuredClone(environment),
      dockerfile,
    },
    runtime: { node: "24.13.0", npm: "11.6.2", docker: true, chromium: true },
    ownership: structuredClone(ownership),
    executionPolicy: structuredClone(executionPolicy),
    ...overrides,
  };
}

function validateActivation(value) {
  return validateActivationEvidence(value, executionPolicy);
}

describe("Cursor Cloud doctor", () => {
  it("accepts deterministic repository/build readiness and records the base-image warning", () => {
    const report = evaluateCursorCloud(readySnapshot(), { build: true });

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

    const report = evaluateCursorCloud(snapshot, { build: true });

    expect(report.status).toBe("blocked:environment");
    expect(report.blockers).toEqual(expect.arrayContaining([
      "repository-policy-invalid",
      "node-version-mismatch",
      "npm-version-mismatch",
    ]));
  });

  it("names unavailable Docker and Chromium without probing provider credentials", () => {
    const report = evaluateCursorCloud(readySnapshot({
      runtime: { node: "24.13.0", npm: "11.6.2", docker: false, chromium: false },
    }), { build: true });

    expect(report.status).toBe("blocked:environment");
    expect(report.blockers).toEqual(["docker-executable-unavailable", "chromium-executable-unavailable"]);
    expect(JSON.stringify(report)).not.toMatch(/token|credential|\.env/iu);
  });

  it("validates a strict redacted activation fixture", () => {
    expect(validateActivation(ready)).toEqual(ready);
    expect(evaluateCursorCloud(readySnapshot(), { build: true, activation: ready })).toMatchObject({
      status: "ready",
      blockers: [],
    });
  });

  it("rejects missing identities, unexpected fields, and credential-shaped input", () => {
    const missingIdentity = structuredClone(ready);
    delete missingIdentity.providers.github.owner;
    expect(() => validateActivation(missingIdentity)).toThrow(/github owner/iu);

    const extra = structuredClone(ready);
    extra.run.note = "unexpected";
    expect(() => validateActivation(extra)).toThrow(/unexpected propert/iu);

    const secretField = structuredClone(ready);
    secretField.providers.github.token = ["ghp", "_123456789012345678901234567890"].join("");
    expect(() => validateActivation(secretField)).toThrow(/secret-shaped/iu);

    const secretValue = structuredClone(ready);
    secretValue.providers.github.owner = ["ghp", "_123456789012345678901234567890"].join("");
    expect(() => validateActivation(secretValue)).toThrow(/secret-shaped/iu);
  });

  it("rejects wrong surfaces, branches, timestamps, models, and reviewer capabilities", () => {
    const mutations = [
      ["surface", (value) => { value.surface = "codex-local"; }],
      ["branch", (value) => { value.repository.branch = "codex/29-cloud-mode"; }],
      ["timestamp", (value) => { value.verifiedAt = "2026-08-22"; }],
      ["calendar timestamp", (value) => { value.verifiedAt = "2026-02-30T12:00:00+09:00"; }],
      ["parent model", (value) => { value.run.modelObserved = "unknown"; }],
      ["reviewer model", (value) => { value.reviewers.openai.observed = "unknown"; }],
      ["fallback model", (value) => { value.reviewers.openai.observed = "claude-opus-5"; }],
      ["readonly probe", (value) => { value.reviewers.anthropic.readonlyProbe = "failed"; }],
      ["provider-tool probe", (value) => { value.reviewers.openai.providerToolProbe = "allowed"; }],
    ];

    for (const [label, mutate] of mutations) {
      const value = structuredClone(ready);
      mutate(value);
      expect(() => validateActivation(value), label).toThrow();
    }
  });

  it("rejects runtime drift and any non-ready Build state", () => {
    for (const mutate of [
      (value) => { value.build.status = "blocked"; },
      (value) => { value.build.node = "25.0.0"; },
      (value) => { value.build.npm = "12.0.0"; },
      (value) => { value.build.docker = false; },
      (value) => { value.build.chromium = false; },
    ]) {
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

    expect(() => validateActivationEvidence(ready, {})).toThrow(/trusted reviewer model/iu);
  });

  it("maps invalid activation surfaces to the repository blocked-state taxonomy", () => {
    const cases = [
      ["blocked:review", (value) => { value.reviewers.openai.providerToolProbe = "allowed"; }],
      ["blocked:conflict", (value) => { value.repository.branch = "codex/29-cloud-mode"; }],
      ["blocked:environment", (value) => { value.build.chromium = false; }],
      ["blocked:ops", (value) => { value.providers.github.status = "unknown"; }],
    ];

    for (const [status, mutate] of cases) {
      const value = structuredClone(ready);
      mutate(value);
      expect(evaluateCursorCloud(readySnapshot(), { build: true, activation: value }).status).toBe(status);
    }
  });

  it("blocks activation when observed owners or targets differ from public ownership config", () => {
    const wrongGitHub = structuredClone(ready);
    wrongGitHub.providers.github.owner = "different-owner";
    wrongGitHub.providers.github.target = "different-owner/Web-Template";
    const githubReport = evaluateCursorCloud(readySnapshot(), { build: true, activation: wrongGitHub });
    expect(githubReport.status).toBe("blocked:ops");
    expect(githubReport.blockers).toEqual(expect.arrayContaining([
      "github-owner-mismatch",
      "github-target-mismatch",
    ]));

    const wrongProviders = structuredClone(ready);
    wrongProviders.providers.supabase.owner = "Different Org";
    wrongProviders.providers.cloudflare.owner = "Different Account";
    const providerReport = evaluateCursorCloud(readySnapshot(), { build: true, activation: wrongProviders });
    expect(providerReport.status).toBe("blocked:ops");
    expect(providerReport.blockers).toEqual(expect.arrayContaining([
      "supabase-owner-mismatch",
      "cloudflare-owner-mismatch",
    ]));
  });

  it("binds activation evidence to the exact collected Cursor branch", () => {
    const stale = structuredClone(ready);
    stale.repository.branch = "cursor/999-stale-activation";
    const staleReport = evaluateCursorCloud(readySnapshot(), { build: true, activation: stale });
    expect(staleReport.status).toBe("blocked:conflict");
    expect(staleReport.blockers).toContain("activation-branch-mismatch");

    for (const branch of [null, "codex/29-cursor-cloud-mode", "feature"] ) {
      const report = evaluateCursorCloud(readySnapshot({
        repository: { ...readySnapshot().repository, branch },
      }), { build: true, activation: ready });
      expect(report.status).toBe("blocked:conflict");
      expect(report.blockers).toContain(branch === null ? "current-branch-unavailable" : "current-branch-not-cursor");
    }
  });

  it("collects only non-secret repository/runtime facts", async () => {
    const marker = "cursor-doctor-must-not-read-this-value";
    process.env.CURSOR_DOCTOR_TEST_SECRET = marker;
    try {
      const snapshot = await collectCursorCloudSnapshot(path.resolve("."));
      const branchResult = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" });
      const expectedBranch = branchResult.status === 0 ? `${branchResult.stdout}`.trim() : null;
      expect(JSON.stringify(snapshot)).not.toContain(marker);
      expect(snapshot.repository.environment).toEqual(environment);
      expect(snapshot.repository.dockerfile).toContain("FROM node:24.13.0-bookworm");
      expect(snapshot.repository.branch).toBe(expectedBranch);
      expect(snapshot.ownership.github).toEqual({ owner: "yuto1201", repository: "Web-Template" });
      expect(snapshot.executionPolicy.cursorModels).toEqual(executionPolicy.cursorModels);
    } finally {
      delete process.env.CURSOR_DOCTOR_TEST_SECRET;
    }
  });

  it("formats activation output without rendering activation evidence values", () => {
    const report = evaluateCursorCloud(readySnapshot(), { build: true, activation: ready });
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
      await writeFile(path.join(artifactDirectory, "activation.json"), `${JSON.stringify(ready)}\n`, "utf8");
      await writeFile(path.join(root, ".env.local"), "PROVIDER_TOKEN=must-not-be-read\n", "utf8");
      await symlink(path.join(root, ".env.local"), path.join(artifactDirectory, "linked.json"));

      await expect(readActivationEvidence(root, ".artifacts/cursor/activation.json", executionPolicy)).resolves.toEqual(ready);
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
