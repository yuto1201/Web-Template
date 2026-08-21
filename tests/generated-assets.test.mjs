import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGeneratedAssets } from "../tools/generate-agent-wrappers.mjs";

const root = path.resolve(".");

describe("generated agent assets", () => {
  it("match their canonical configuration and contracts", async () => {
    const assets = await buildGeneratedAssets(root);
    for (const [relative, expected] of assets) {
      await expect(readFile(path.join(root, relative), "utf8")).resolves.toBe(expected);
    }
  });

  it("emit valid first-line frontmatter and least-privilege Claude tools", async () => {
    const assets = await buildGeneratedAssets(root);
    for (const [relative, content] of assets) {
      if (!relative.startsWith(`.claude${path.sep}agents${path.sep}`)) {
        continue;
      }
      expect(content.split("\n", 1)[0]).toBe("---");
      expect(content).toContain("tools: Read, Grep, Glob");
      expect(content).not.toMatch(/^tools:.*\bWrite\b/mu);
      expect(content).not.toMatch(/^tools:.*\bBash\b/mu);
    }
  });
});
