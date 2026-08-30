import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGeneratedAssets } from "../tools/generate-agent-wrappers.mjs";
import {
  detectActorAsymmetry,
  hasCanonicalOperatorParityStatement,
} from "../tools/repository-policy.mjs";

const root = path.resolve(".");

/** @param {string} relativePath */
async function fileExists(relativePath) {
  try {
    await access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

describe("Claude and Codex operator parity", () => {
  it("removes the repository-imposed Claude-only tool guard", async () => {
    const settings = JSON.parse(
      await readFile(path.join(root, ".claude", "settings.json"), "utf8"),
    );

    expect(settings.permissions?.deny ?? []).not.toContain("Bash");
    expect(JSON.stringify(settings)).not.toContain("guard-claude-tool.mjs");
    expect(detectActorAsymmetry(JSON.stringify(settings))).toBeNull();
    await expect(fileExists("tools/guard-claude-tool.mjs")).resolves.toBe(false);
  });

  it("grants Claude implementers and external operators the shared account-bound authority", async () => {
    const assets = await buildGeneratedAssets(root);
    const generatedClaude = assets.get("CLAUDE.md");

    expect(hasCanonicalOperatorParityStatement(generatedClaude ?? "")).toBe(true);
    expect(generatedClaude).toContain("implementer and external-operator roles");
    expect(detectActorAsymmetry(generatedClaude ?? "")).toBeNull();
  });

  it("keeps Claude and Codex evaluator roles read-only", async () => {
    const assets = await buildGeneratedAssets(root);

    for (const [relativePath, content] of assets) {
      if (relativePath.startsWith(`.claude${path.sep}agents${path.sep}`)) {
        const tools = content.match(/^tools:\s*(.+)$/mu)?.[1]
          ?.split(",")
          .map((tool) => tool.trim());
        expect(tools).toEqual(["Read", "Grep", "Glob"]);
      }
      if (relativePath.startsWith(`.codex${path.sep}agents${path.sep}`)) {
        expect(content.match(/^sandbox_mode\s*=\s*"([^"]+)"$/mu)?.[1]).toBe("read-only");
      }
    }
  });
});
