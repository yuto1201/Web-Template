import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("acceptance trace", () => {
  it("audits Issue #29 as a canonical acceptance entry", () => {
    const command = spawnSync(process.execPath, ["tools/verify-acceptance-trace.mjs"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      windowsHide: true,
    });

    expect(command.status, command.stderr).toBe(0);
    expect(JSON.parse(command.stdout)).toMatchObject({ ok: true, issues: 11 });
  });
});
