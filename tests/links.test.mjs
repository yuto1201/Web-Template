import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findBrokenMarkdownLinks } from "../tools/verify-links.mjs";

describe("Markdown link verification", () => {
  it("accepts repository-local and external links", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "link-check-"));
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "README.md"), "[local](docs/guide.md) [external](https://example.com)\n", "utf8");
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n", "utf8");
    await expect(findBrokenMarkdownLinks(root)).resolves.toEqual([]);
  });

  it("reports missing and escaping targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "link-check-"));
    await writeFile(path.join(root, "README.md"), "[missing](docs/nope.md) [escape](../outside.md)\n", "utf8");
    const errors = await findBrokenMarkdownLinks(root);
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toMatch(/missing local link target/u);
    expect(errors.join("\n")).toMatch(/escapes the repository/u);
  });
});
