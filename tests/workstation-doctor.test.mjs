import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectWorkstationSnapshot,
  commandOutput,
  evaluateWorkstation,
  formatWorkstationReport,
} from "../tools/workstation-doctor.mjs";

const expectedNodeVersion = "24.13.0";
const expectedNpmVersion = "11.6.2";

function readySnapshot(overrides = {}) {
  return {
    platform: "darwin",
    arch: "arm64",
    requiredNodeVersion: expectedNodeVersion,
    requiredNpmVersion: expectedNpmVersion,
    nodeVersion: expectedNodeVersion,
    npmVersion: expectedNpmVersion,
    gitVersion: "git version 2.50.1",
    repository: { git: true, packageJson: true, packageLock: true, agents: true },
    dependenciesInstalled: true,
    environmentFilePresent: false,
    docker: { cliAvailable: false, daemonReachable: false },
    ...overrides,
  };
}

describe("workstation doctor", () => {
  it.each(["arm64", "x64"])("accepts a pinned macOS %s workstation", (arch) => {
    const report = evaluateWorkstation(readySnapshot({ arch }));
    expect(report.ok).toBe(true);
    expect(report.status).toBe("ready");
    expect(report.checks.find((entry) => entry.id === "environment")?.status).toBe("optional");
    expect(report.checks.find((entry) => entry.id === "docker-daemon")?.status).toBe("optional");
  });

  it("fails closed on runtime drift and an incomplete repository root", () => {
    const report = evaluateWorkstation(readySnapshot({
      nodeVersion: "25.0.0",
      npmVersion: "12.0.0",
      repository: { git: false, packageJson: true, packageLock: false, agents: true },
      dependenciesInstalled: false,
    }));
    expect(report.ok).toBe(false);
    expect(report.status).toBe("action-required");
    expect(report.checks.filter((entry) => entry.status === "fail").map((entry) => entry.id)).toEqual([
      "node",
      "npm",
      "repository-root",
      "dependencies",
    ]);
  });

  it("promotes environment and Docker from optional to required gates", () => {
    const report = evaluateWorkstation(readySnapshot(), { requireDocker: true, requireEnvironment: true });
    expect(report.ok).toBe(false);
    expect(report.checks.filter((entry) => entry.status === "fail").map((entry) => entry.id)).toEqual([
      "environment",
      "docker-cli",
      "docker-daemon",
    ]);
  });

  it("reports environment presence without reading or rendering values", () => {
    const report = evaluateWorkstation(readySnapshot({
      environmentFilePresent: true,
      docker: { cliAvailable: true, daemonReachable: true },
    }), { requireDocker: true, requireEnvironment: true });
    const output = formatWorkstationReport(report);
    expect(report.ok).toBe(true);
    expect(output).toContain(".env.local is present; values were not read.");
    expect(output).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|NEXT_PUBLIC_SUPABASE/u);
  });

  it("rejects architectures outside the pinned dependency contract", () => {
    const report = evaluateWorkstation(readySnapshot({ arch: "riscv64" }));
    expect(report.ok).toBe(false);
    expect(report.checks.find((entry) => entry.id === "architecture")?.status).toBe("fail");
  });

  it("reads expected versions from repository source files instead of duplicated constants", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workstation-doctor-"));
    try {
      await mkdir(path.join(root, ".git"));
      await mkdir(path.join(root, "node_modules"));
      await writeFile(path.join(root, ".node-version"), "30.1.2\n", "utf8");
      await writeFile(path.join(root, "package.json"), `${JSON.stringify({ packageManager: "npm@13.4.5" })}\n`, "utf8");
      await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
      await writeFile(path.join(root, "AGENTS.md"), "# Test\n", "utf8");
      await writeFile(path.join(root, "node_modules", ".package-lock.json"), "{}\n", "utf8");

      const snapshot = await collectWorkstationSnapshot(root);
      expect(snapshot.requiredNodeVersion).toBe("30.1.2");
      expect(snapshot.requiredNpmVersion).toBe("13.4.5");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses a successful version command from stdout without including warnings from stderr", () => {
    const output = commandOutput(process.execPath, [
      "-e",
      "process.stdout.write('11.6.2\\n'); process.stderr.write('npm warning\\n');",
    ]);

    expect(output).toBe("11.6.2");
  });
});
