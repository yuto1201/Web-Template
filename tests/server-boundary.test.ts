// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("server module marker", () => {
  it("keeps server-only as the first executable import", async () => {
    const source = await readFile(new URL("../src/lib/env/server.ts", import.meta.url), "utf8");
    expect(source.trimStart().startsWith('import "server-only";')).toBe(true);
  });
});
