import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintDeploymentWorkflows } from "../tools/deployment-core.mjs";

/** @param {string} content */
async function rootWithWorkflow(content) {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-template-workflow-"));
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(root, ".github", "workflows", "deploy.yml"), content, "utf8");
  return root;
}

describe("deployment workflow lint", () => {
  it("accepts pull_request and a token supplied only through process environment", async () => {
    const root = await rootWithWorkflow("on:\n  pull_request:\njobs:\n  check:\n    steps:\n      - run: npm run deployment:lint\n");
    await expect(lintDeploymentWorkflows(root)).resolves.toEqual([]);
  });

  it("forbids pull_request_target and secret-like output", async () => {
    const root = await rootWithWorkflow("on:\n  pull_request_target:\njobs:\n  unsafe:\n    steps:\n      - run: echo $VERCEL_TOKEN\n");
    await expect(lintDeploymentWorkflows(root)).resolves.toEqual([
      "deploy.yml: pull_request_target is forbidden.",
      "deploy.yml: secret-like environment output is forbidden.",
    ]);
  });
});
