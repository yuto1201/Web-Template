import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this audit through npm run audit:completion.");
const includeIntegration = process.argv.includes("--include-integration");
const requireAll = process.argv.includes("--require-all");
/** @type {Array<[string, string[]]>} */
const checks = [
  ["repository-policy", ["run", "policy"]],
  ["workstation", ["run", "workstation:doctor"]],
  ["template-source", ["run", "template:source-check"]],
  ["readiness", ["run", "readiness"]],
  ["markdown-links", ["run", "check:links"]],
  ["wrapper-drift", ["run", "check:generated"]],
  ["acceptance-trace", ["run", "audit:trace"]],
  ["deployment-policy", ["run", "deployment:lint"]],
  ["domain-policy", ["run", "domain:lint"]],
  ["lint", ["run", "lint"]],
  ["typecheck", ["run", "typecheck"]],
  ["unit", ["test"]],
  ["account-authority", ["exec", "--", "vitest", "run", "tests/authority-core.test.mjs"]],
  ["operator-parity", ["exec", "--", "vitest", "run", "tests/operator-parity.test.mjs"]],
  ["workflow", ["exec", "--", "vitest", "run", "tests/workflow-contract.test.mjs", "tests/workflow-e2e.test.mjs", "tests/workflow-gate.test.mjs", "tests/github-review-gate.test.mjs"]],
  ["provider-lifecycle", ["exec", "--", "vitest", "run", "tests/provider-guarded-adapter.test.mjs", "tests/domain-workflow.test.mjs", "tests/deployment-release.test.mjs"]],
  ["server-boundary", ["run", "test:boundary"]],
  ["client-leak-scan", ["run", "test:client-scan"]],
  ["build", ["run", "build:ci"]],
  ["clean-room", ["run", "template:verify"]],
];
/** @type {Array<[string, string[]]>} */
const integrationChecks = [
  ["browser-smoke", ["run", "test:e2e"]],
  ["database-policy", ["run", "db:verify"]],
  ["auth-integration", ["run", "auth:verify"]],
];

const results = [];
for (const [name, args] of checks) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const status = result.status === 0 ? "passed" : "failed";
  results.push({ name, status, durationMs: Date.now() - started });
  if (status !== "passed") process.stderr.write(`${name}: ${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}
for (const [name, args] of integrationChecks) {
  if (!includeIntegration) {
    results.push({ name, status: "not-run", durationMs: 0, reason: "Pass --include-integration to run this check." });
    continue;
  }
  const started = Date.now();
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const status = result.status === 0 ? "passed" : result.status === 2 && (name === "database-policy" || name === "auth-integration") ? "not-run" : "failed";
  results.push({ name, status, durationMs: Date.now() - started });
  if (status !== "passed") process.stderr.write(`${name}: ${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}
const summary = {
  schemaVersion: 1,
  status: results.some((entry) => entry.status === "failed") ? "failed" : results.some((entry) => entry.status === "not-run") ? "partial" : "passed",
  counts: {
    passed: results.filter((entry) => entry.status === "passed").length,
    failed: results.filter((entry) => entry.status === "failed").length,
    notRun: results.filter((entry) => entry.status === "not-run").length,
  },
  checks: results,
};
await mkdir(path.join(process.cwd(), ".artifacts"), { recursive: true });
await writeFile(path.join(process.cwd(), ".artifacts", "completion-audit.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.counts.failed > 0) process.exitCode = 1;
else if (requireAll && summary.counts.notRun > 0) process.exitCode = 2;
