import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as templateCore from "../tools/template-core.mjs";
import {
  discoverOccurrences,
  initializeTemplate,
  projectTokens,
  readTemplateState,
} from "../tools/template-core.mjs";

const cursorGuardrailPaths = [
  ".cursor/environment.json",
  ".cursor/hooks.json",
  ".cursor/agents/change-evaluator-anthropic.md",
  ".cursor/agents/change-evaluator-openai.md",
  ".cursor/agents/consultant-anthropic.md",
  ".cursor/agents/consultant-openai.md",
  ".cursor/agents/supabase-auditor-anthropic.md",
  ".cursor/agents/supabase-auditor-openai.md",
  "config/execution.json",
  "docs/onboarding-cursor-cloud.md",
];

/** @type {string[]} */
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sourceProject() {
  return {
    appName: "Starter Source",
    slug: "starter-source",
    github: { owner: "source-owner", repository: "Starter-Source" },
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
    ownership: {
      supabase: { organizationName: "Source Org", projectRef: null },
      vercel: { scope: "team_SOURCE1", projectId: "prj_SOURCE1" },
      cloudflare: {
        accountId: "a".repeat(32),
        accountName: "Source Cloudflare",
        zoneId: "b".repeat(32),
        zoneName: "example.test",
      },
    },
  };
}

async function sourceFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "template-init-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "config"));
  await mkdir(path.join(root, ".cursor", "agents"), { recursive: true });
  await mkdir(path.join(root, "docs"));
  const project = sourceProject();
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: project.slug }, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(root, "README.md"),
    `# ${project.appName}\n\n[Cursor Cloud onboarding](docs/onboarding-cursor-cloud.md)\n`,
    "utf8",
  );
  await writeFile(path.join(root, ".cursor", "environment.json"), "{\"build\":{}}\n", "utf8");
  await writeFile(path.join(root, ".cursor", "hooks.json"), "{\"version\":1}\n", "utf8");
  for (const relative of cursorGuardrailPaths.filter((candidate) => candidate.startsWith(".cursor/agents/"))) {
    const name = path.basename(relative, ".md");
    await writeFile(path.join(root, relative), `---\nname: ${name}\nreadonly: true\n---\n`, "utf8");
  }
  await writeFile(path.join(root, "config", "execution.json"), "{\"schemaVersion\":1}\n", "utf8");
  await writeFile(
    path.join(root, "docs", "onboarding-cursor-cloud.md"),
    "# Cursor Cloud onboarding\n\nProvider activation: needs-cursor-or-codex.\n",
    "utf8",
  );
  await writeFile(path.join(root, "config", "ownership.json"), `${JSON.stringify({
    schemaVersion: 1,
    github: project.github,
    supabase: project.ownership.supabase,
    vercel: project.ownership.vercel,
    cloudflare: {
      accountId: project.ownership.cloudflare.accountId,
      accountName: project.ownership.cloudflare.accountName,
      zoneId: project.ownership.cloudflare.zoneId,
      domains: [new URL(project.publicUrls.production).hostname],
    },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "config", "domain.json"), `${JSON.stringify({
    schemaVersion: 1,
    hostname: new URL(project.publicUrls.production).hostname,
    zoneName: project.ownership.cloudflare.zoneName,
    recordName: project.slug,
  }, null, 2)}\n`, "utf8");
  const initialState = { schemaVersion: 1, status: "template-source", project, occurrences: {} };
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
    schemaVersion: 1,
    appName: "Clean Room App",
    slug: "clean-room-app",
    github: { owner: "example-owner", repository: "clean-room-app" },
    localPorts: { app: 4310, supabaseBase: 56320 },
    publicUrls: { production: "https://clean-room-app.example.invalid" },
    ownership: {
      supabase: { organizationName: null, projectRef: null },
      vercel: { scope: null, projectId: null },
      cloudflare: { accountId: null, accountName: null, zoneId: null, zoneName: "example.invalid" },
    },
  };
}

describe("template initialization", () => {
  it("ignores Git administrative files while retaining ordinary project files in source scans", async () => {
    const root = await sourceFixture();
    const project = sourceProject();
    await writeFile(path.join(root, ".git"), `gitdir: /workspace/${project.github.repository}/.git/worktrees/fixture\n`, "utf8");
    await writeFile(path.join(root, "ordinary.txt"), `${project.github.repository}\n`, "utf8");

    const occurrences = await discoverOccurrences(root, projectTokens(project));

    expect(occurrences.githubRepository).not.toHaveProperty(".git");
    expect(occurrences.githubRepository).toHaveProperty("ordinary.txt", 1);
  });

  it("excludes only ignored .superpowers/sdd controller scratch from source scans", async () => {
    const root = await sourceFixture();
    const project = sourceProject();
    await mkdir(path.join(root, ".superpowers", "sdd"), { recursive: true });
    await writeFile(path.join(root, ".superpowers", "sdd", ".gitignore"), "*\n", "utf8");
    await writeFile(
      path.join(root, ".superpowers", "sdd", "task-brief.md"),
      `${project.github.repository}\n`,
      "utf8",
    );
    await writeFile(path.join(root, ".superpowers", "source-note.md"), `${project.github.repository}\n`, "utf8");

    const occurrences = await discoverOccurrences(root, projectTokens(project));

    expect(occurrences.githubRepository).not.toHaveProperty(".superpowers/sdd/task-brief.md");
    expect(occurrences.githubRepository).toHaveProperty(".superpowers/source-note.md", 1);

    await rm(path.join(root, ".superpowers", "sdd", ".gitignore"));
    const unignored = await discoverOccurrences(root, projectTokens(project));
    expect(unignored.githubRepository).toHaveProperty(".superpowers/sdd/task-brief.md", 1);
  });

  it("retains the Cursor environment, hooks, six agents, execution policy, and onboarding link", async () => {
    const root = await sourceFixture();
    const before = Object.fromEntries(await Promise.all(cursorGuardrailPaths.map(async (relative) => [
      relative,
      await readFile(path.join(root, relative), "utf8"),
    ])));

    const inspection = await templateCore.verifyCursorTemplateRetention(root);
    await initializeTemplate(root, configuration());
    const after = Object.fromEntries(await Promise.all(cursorGuardrailPaths.map(async (relative) => [
      relative,
      await readFile(path.join(root, relative), "utf8"),
    ])));

    expect(inspection).toEqual({
      files: cursorGuardrailPaths,
      cursorAgents: 6,
      onboarding: "docs/onboarding-cursor-cloud.md",
    });
    expect(after).toEqual(before);
    expect(await readFile(path.join(root, "README.md"), "utf8")).toContain(
      "[Cursor Cloud onboarding](docs/onboarding-cursor-cloud.md)",
    );
  });

  it("rejects a provider credential in retained Cursor template files", async () => {
    const root = await sourceFixture();
    const credential = ["ghp", "_123456789012345678901234567890"].join("");
    await writeFile(
      path.join(root, ".cursor", "hooks.json"),
      `${JSON.stringify({ version: 1, credential })}\n`,
      "utf8",
    );

    await expect(templateCore.verifyCursorTemplateRetention(root)).rejects.toThrow(/credential/u);
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
    expect(JSON.parse(await readFile(path.join(target, "config", "ownership.json"), "utf8"))).toMatchObject({
      github: { owner: "example-owner", repository: "clean-room-app" },
      vercel: { scope: "team_REPLACEWITHCODEX", projectId: "prj_REPLACEWITHCODEX" },
      cloudflare: { domains: ["clean-room-app.example.invalid"] },
    });
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
    unsafeOrganization.ownership.supabase.organizationName = "unsafe\norganization";
    await expect(initializeTemplate(target, unsafeOrganization)).rejects.toThrow(/organizationName is invalid/u);
    const unsafeCloudflareName = /** @type {any} */ (configuration());
    unsafeCloudflareName.ownership.cloudflare.accountName = 'unsafe "account"';
    await expect(initializeTemplate(target, unsafeCloudflareName)).rejects.toThrow(/accountName is invalid/u);
  });

  it("refuses a different configuration after successful initialization", async () => {
    const target = await sourceFixture();
    await initializeTemplate(target, configuration());
    const changed = configuration();
    changed.appName = "Another App";
    await expect(initializeTemplate(target, changed)).rejects.toThrow(/already initialized with different values/u);
  });
});
