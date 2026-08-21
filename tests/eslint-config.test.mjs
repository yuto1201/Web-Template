import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

describe("ESLint repository boundaries", () => {
  it("ignores linked worktrees from the parent checkout", async () => {
    const eslint = new ESLint({ cwd: path.resolve(".") });

    await expect(eslint.isPathIgnored(".worktrees/fixture/.next/generated.js")).resolves.toBe(true);
    await expect(eslint.isPathIgnored("tests/eslint-config.test.mjs")).resolves.toBe(false);
  });
});
