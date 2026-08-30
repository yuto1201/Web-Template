import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { containsPotentialSecret, validateRepository } from "../tools/repository-policy.mjs";

describe("repository policy", () => {
  it("keeps required policy, ownership, agent, and secret boundaries valid", async () => {
    const authority = JSON.parse(await readFile(path.resolve("config/ownership.json"), "utf8"));
    const template = JSON.parse(await readFile(path.resolve("config/template.json"), "utf8"));
    expect(template.project.observations.github.observedAt).not.toBe(authority.observations.github.observedAt);
    await expect(validateRepository(path.resolve("."))).resolves.toEqual([]);
  });

  it("detects representative provider credentials without flagging placeholders", () => {
    expect(containsPotentialSecret(["AK", "IA1234567890ABCDEF"].join(""))).toBe(true);
    expect(containsPotentialSecret(["sb", "p_12345678901234567890"].join(""))).toBe(true);
    expect(containsPotentialSecret(["-----BEGIN PRIVATE", " KEY-----"].join(""))).toBe(true);
    expect(containsPotentialSecret("SUPABASE_SERVICE_ROLE_KEY=replace-me")).toBe(false);
  });
});
