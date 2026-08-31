import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("acceptance trace", () => {
  it("audits the current canonical acceptance entries", () => {
    const command = spawnSync(process.execPath, ["tools/verify-acceptance-trace.mjs"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      windowsHide: true,
    });

    expect(command.status, command.stderr).toBe(0);
    expect(JSON.parse(command.stdout)).toMatchObject({ ok: true, issues: 14 });
  });

  it("retains legal surfaces and their regression checks in the trace", async () => {
    const trace = JSON.parse(await readFile("config/acceptance.json", "utf8"));
    const legal = trace.issues.find(/** @param {{ issue: number }} entry */ (entry) => entry.issue === 37);

    expect(legal?.evidence).toEqual(expect.arrayContaining([
      "src/app/terms/page.tsx",
      "src/app/privacy/page.tsx",
      "src/components/legal-document.tsx",
      "src/components/site-footer.tsx",
      "src/app/layout.tsx",
      "src/proxy.ts",
      "tests/legal-pages.test.tsx",
      "tests/legal-proxy.test.ts",
      "tests/e2e/legal-pages.spec.ts",
    ]));
    expect(legal?.commands).toEqual(expect.arrayContaining(["audit:trace", "test", "test:e2e"]));
  });

  it("requires theme decisions and their workflow entrypoints in the audited evidence", async () => {
    const trace = JSON.parse(await readFile("config/acceptance.json", "utf8"));
    const theme = trace.issues.find(/** @param {{ issue: number }} entry */ (entry) => entry.issue === 39);

    expect(theme?.evidence).toEqual(expect.arrayContaining([
      "specs/design-system.md",
      "specs/README.md",
      "specs/product.md",
      "specs/acceptance.md",
      "specs/decisions.md",
      "AGENTS.md",
      "README.md",
      "docs/workflow.md",
      "docs/activation.md",
    ]));
    expect(theme?.commands).toEqual(expect.arrayContaining(["audit:trace", "check", "template:verify"]));
  });
});
