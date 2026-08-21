import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverOccurrences,
  initializeTemplate,
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
  const project = sourceProject();
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: project.slug }, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "README.md"), `# ${project.appName}\n`, "utf8");
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
  });

  it("refuses a different configuration after successful initialization", async () => {
    const target = await sourceFixture();
    await initializeTemplate(target, configuration());
    const changed = configuration();
    changed.appName = "Another App";
    await expect(initializeTemplate(target, changed)).rejects.toThrow(/already initialized with different values/u);
  });
});
