// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanClientBundle } from "../tools/scan-client-bundle.mjs";

const temporaryDirectories: string[] = [];

function jwt(role: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role })}.signature-value`;
}

async function fixture(content: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "web-template-client-scan-"));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, "chunks"));
  await writeFile(path.join(directory, "chunks", "app.js"), content, "utf8");
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("client bundle secret scanner", () => {
  it("passes a clean client bundle", async () => {
    expect(await scanClientBundle(await fixture("const publicValue = 'sb_publishable_visible_value_123456';"))).toEqual([]);
  });

  it.each([
    ["Supabase secret key", ["sb", "secret", "PRIVATE_VALUE_123456789"].join("_")],
    ["server-only build sentinel", "SERVER_ONLY_BUILD_SENTINEL_123456"],
    ["decoded service-role claim", "{\"role\":\"service_role\"}"],
    ["legacy service-role JWT", jwt("service_role")],
  ])("finds %s without returning the credential", async (label, content) => {
    const findings = await scanClientBundle(await fixture(content));
    expect(findings).toEqual([{ file: path.join("chunks", "app.js"), label }]);
    expect(JSON.stringify(findings)).not.toContain(content);
  });

  it("finds an opaque server environment value but reports only its variable name", async () => {
    const privateValue = "opaque-private-build-value-123456";
    const findings = await scanClientBundle(
      await fixture(`const leaked = '${privateValue}';`),
      [{ name: "GENERIC_API_TOKEN", value: privateValue }],
    );
    expect(findings).toEqual([{
      file: path.join("chunks", "app.js"),
      label: "server environment value (GENERIC_API_TOKEN)",
    }]);
    expect(JSON.stringify(findings)).not.toContain(privateValue);
  });
});
