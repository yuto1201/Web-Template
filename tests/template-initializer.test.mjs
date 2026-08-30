import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverOccurrences,
  initializeTemplate,
  normalizeInitializationConfig,
  projectTokens,
  readTemplateState,
} from "../tools/template-core.mjs";

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sourceProject() {
  return {
    schemaVersion: 2,
    appName: "Starter Source",
    slug: "starter-source",
    localPorts: {
      app: 4510,
      supabaseBase: 45320,
      supabaseApi: 45321,
      supabaseDb: 45322,
      supabaseStudio: 45323,
      supabaseMail: 45324,
      supabaseAnalytics: 45327,
      supabasePooler: 45329,
      supabaseInspector: 45383,
    },
    publicUrls: {
      localhost: "http://localhost:4510",
      loopback: "http://127.0.0.1:4510",
      production: "https://starter-source.example.test",
    },
    authorization: {
      operatorLabels: ["codex", "claude"],
      externalOperatorRoles: ["implementer", "external-operator"],
      allowAutomaticAccountSwitch: false,
    },
    accounts: {
      github: { login: "source-owner", userId: 123456, nodeId: "SOURCE_GITHUB_NODE" },
      supabase: { organizationName: "Source Org", organizationId: "sourcesupabaseorg001" },
      vercel: { teamName: "Source Team", teamSlug: "source-team", teamId: "team_SOURCE1", requiredPlan: "Hobby" },
      cloudflare: {
        accountId: ["7ea8e713d76506f9e303f", "58624829aa5"].join(""),
        accountName: "Source Cloudflare",
        loginEmailHint: "s***@example.test",
        loginEmailSha256: "c".repeat(64),
        requiredRole: "Super Administrator",
        allowedZonePlans: ["Free"],
      },
      linear: {
        workspaceName: "Source Workspace",
        workspaceSlug: "source-workspace",
        workspaceUrl: "https://linear.app/source-workspace",
        workspaceId: "source-workspace-id",
        userName: "Source User",
        userEmailHint: "u***@example.test",
        userEmailSha256: "d".repeat(64),
        userId: "source-user-id",
        requiredRole: "Admin",
      },
    },
    servicePolicies: {
      github: { mode: "repository-active" },
      supabase: { mode: "repository-active" },
      vercel: { mode: "repository-active" },
      cloudflare: { mode: "repository-active" },
      linear: { mode: "explicit-user-purpose-only" },
    },
    resourceTargets: {
      github: { owner: "source-owner", repository: "Starter-Source", repositoryId: 654321, repositoryNodeId: "SOURCE_REPOSITORY_NODE" },
      supabase: { projectRef: null },
      vercel: { projectId: "prj_SOURCE1" },
      cloudflare: { zoneId: "b".repeat(32), domains: ["starter-source.example.test"] },
      linear: { teamKey: "SRC", teamId: "source-team-id" },
    },
    observations: {
      github: {
        displayName: "Source Display Name",
        createdAt: "2019-05-14T06:31:57Z",
        publicRepositories: 9,
        observedAt: "2026-08-30T00:00:00+09:00",
      },
    },
  };
}

async function sourceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "template-init-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "config"));
  const project = sourceProject();
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: project.slug }, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "README.md"), `# ${project.appName}\n`, "utf8");
  await writeFile(path.join(root, "config", "ownership.json"), `${JSON.stringify({
    schemaVersion: project.schemaVersion,
    authorization: project.authorization,
    accounts: project.accounts,
    servicePolicies: project.servicePolicies,
    resourceTargets: project.resourceTargets,
    observations: project.observations,
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "config", "domain.json"), `${JSON.stringify({
    schemaVersion: 1,
    hostname: new URL(project.publicUrls.production).hostname,
    zoneName: "example.test",
    recordName: project.slug,
  }, null, 2)}\n`, "utf8");
  const initialState = { schemaVersion: 2, status: "template-source", project, occurrences: {} };
  await writeFile(path.join(root, "config", "template.json"), `${JSON.stringify(initialState, null, 2)}\n`, "utf8");
  initialState.occurrences = await discoverOccurrences(root, projectTokens(project));
  await writeFile(path.join(root, "config", "template.json"), `${JSON.stringify(initialState, null, 2)}\n`, "utf8");
  return root;
}

async function initializedVerifierFixture() {
  const root = await sourceFixture();
  await initializeTemplate(root, configuration());
  await mkdir(path.join(root, "tools"));
  await copyFile(path.resolve("tools/template-core.mjs"), path.join(root, "tools", "template-core.mjs"));
  await copyFile(path.resolve("tools/verify-template-instantiation.mjs"), path.join(root, "tools", "verify-template-instantiation.mjs"));
  /** @param {string[]} args */
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (git("init", "--quiet").status !== 0 || git("add", "config/template.json", "package.json", "tools/template-core.mjs", "tools/verify-template-instantiation.mjs").status !== 0) {
    throw new Error("Failed to create initialized verifier fixture.");
  }
  return root;
}

function configuration() {
  return {
    schemaVersion: 2,
    appName: "Clean Room App",
    slug: "clean-room-app",
    localPorts: { app: 4310, supabaseBase: 56320 },
    publicUrls: { production: "https://clean-room-app.example.invalid" },
    accounts: {
      github: { login: "target-owner", userId: null, nodeId: null },
      supabase: { organizationName: null, organizationId: null },
      vercel: { teamName: null, teamSlug: null, teamId: null, requiredPlan: null },
      cloudflare: {
        accountId: null,
        accountName: null,
        loginEmailHint: null,
        loginEmailSha256: null,
        requiredRole: null,
        allowedZonePlans: null,
      },
      linear: {
        workspaceName: null,
        workspaceSlug: null,
        workspaceUrl: null,
        workspaceId: null,
        userName: null,
        userEmailHint: null,
        userEmailSha256: null,
        userId: null,
        requiredRole: null,
      },
    },
    servicePolicies: {
      github: { mode: "repository-active" },
      supabase: { mode: "repository-active" },
      vercel: { mode: "repository-active" },
      cloudflare: { mode: "repository-active" },
      linear: { mode: "explicit-user-purpose-only" },
    },
    resourceTargets: {
      github: { owner: "target-owner", repository: "clean-room-app", repositoryId: null, repositoryNodeId: null },
      supabase: { projectRef: null },
      vercel: { projectId: null },
      cloudflare: { zoneId: null, domains: ["clean-room-app.example.invalid"] },
      linear: { teamKey: null, teamId: null },
    },
  };
}

describe("template initialization", () => {
  it("ignores Git administrative files while retaining ordinary project files in source scans", async () => {
    const root = await sourceFixture();
    const project = sourceProject();
    await writeFile(path.join(root, ".git"), `gitdir: /workspace/${project.resourceTargets.github.repository}/.git/worktrees/fixture\n`, "utf8");
    await writeFile(path.join(root, "ordinary.txt"), `${project.resourceTargets.github.repository}\n`, "utf8");

    const occurrences = await discoverOccurrences(root, projectTokens(project));

    expect(occurrences.githubRepository).not.toHaveProperty(".git");
    expect(occurrences.githubRepository).toHaveProperty("ordinary.txt", 1);
  });

  it("reports clean-room verification as not applicable for an initialized repository", async () => {
    const root = await initializedVerifierFixture();
    const command = spawnSync(process.execPath, ["tools/verify-template-instantiation.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_execpath: process.env.npm_execpath ?? process.execPath },
      windowsHide: true,
    });

    expect(command.status, command.stderr).toBe(0);
    expect(JSON.parse(command.stdout)).toEqual({
      ok: true,
      status: "initialized-repository",
      cleanRoom: "not-applicable",
      reason: "Clean-room instantiation applies only to the template source.",
    });
  });

  it("replaces every reviewed source occurrence and is idempotent for identical input", async () => {
    const target = await sourceFixture();
    const source = await readTemplateState(target);
    const first = await initializeTemplate(target, configuration());
    expect(first.status).toBe("initialized");
    expect(first.changedFiles).toContain("config/ownership.json");
    const remaining = await discoverOccurrences(target, projectTokens(source.project));
    expect(Object.values(remaining).every((files) => Object.keys(files).length === 0)).toBe(true);
    await expect(initializeTemplate(target, configuration())).resolves.toEqual({ ok: true, status: "idempotent", changedFiles: [] });
    expect(JSON.parse(await readFile(path.join(target, "package.json"), "utf8")).name).toBe("clean-room-app");
    const initializedAuthority = JSON.parse(await readFile(path.join(target, "config", "ownership.json"), "utf8"));
    expect(initializedAuthority).toMatchObject({
      schemaVersion: 2,
      accounts: {
        github: { login: "target-owner" },
        linear: { workspaceId: null, userId: null },
        vercel: { teamId: "team_REPLACEWITHCODEX" },
      },
      resourceTargets: {
        github: { owner: "target-owner", repository: "clean-room-app" },
        vercel: { projectId: "prj_REPLACEWITHCODEX" },
        cloudflare: { domains: ["clean-room-app.example.invalid"] },
      },
    });
    expect(JSON.stringify(initializedAuthority)).not.toContain(["7ea8e713d76506f9e303f", "58624829aa5"].join(""));
    await writeFile(path.join(target, "package.json"), `${JSON.stringify({ name: "edited-after-init" }, null, 2)}\n`, "utf8");
    await expect(initializeTemplate(target, configuration())).rejects.toThrow(/managed file changed/u);
  });

  it("refuses before writing when a managed source value was edited", async () => {
    const target = await sourceFixture();
    const packagePath = path.join(target, "package.json");
    await writeFile(packagePath, `${JSON.stringify({ name: "already-customized" }, null, 2)}\n`, "utf8");
    await expect(initializeTemplate(target, configuration())).rejects.toThrow(/refusing to overwrite edited values/u);
    expect(JSON.parse(await readFile(packagePath, "utf8")).name).toBe("already-customized");
  });

  it("rejects overlapping ports and production hostnames that do not match the slug and zone", async () => {
    const target = await sourceFixture();
    const overlapping = configuration();
    overlapping.localPorts.app = overlapping.localPorts.supabaseBase;
    await expect(initializeTemplate(target, overlapping)).rejects.toThrow(/must not overlap/u);
    const wrongHost = configuration();
    wrongHost.publicUrls.production = "https://different.example.invalid";
    await expect(initializeTemplate(target, wrongHost)).rejects.toThrow(/slug\.cloudflareZoneName/u);
    const unsafeOrganization = /** @type {any} */ (configuration());
    unsafeOrganization.accounts.supabase.organizationName = "unsafe\norganization";
    await expect(initializeTemplate(target, unsafeOrganization)).rejects.toThrow(/organizationName is invalid/u);
    const unsafeCloudflareName = /** @type {any} */ (configuration());
    unsafeCloudflareName.accounts.cloudflare.accountName = 'unsafe "account"';
    await expect(initializeTemplate(target, unsafeCloudflareName)).rejects.toThrow(/accountName is invalid/u);
  });

  it("rejects a partially specified provider authority group", () => {
    const partial = configuration();
    partial.accounts.vercel.teamId = "team_PARTIAL";
    expect(() => normalizeInitializationConfig(partial)).toThrow(/partial authority/u);
  });

  it("refuses a different configuration after successful initialization", async () => {
    const target = await sourceFixture();
    await initializeTemplate(target, configuration());
    const changed = configuration();
    changed.appName = "Another App";
    await expect(initializeTemplate(target, changed)).rejects.toThrow(/already initialized with different values/u);
  });
});
