import { describe, expect, it } from "vitest";
import { EnvironmentConfigurationError } from "@/lib/env/error";
import { parsePublicEnvironment, readJwtRole } from "@/lib/env/public-schema";
import { parseServerEnvironment } from "@/lib/env/server-schema";

function jwt(role: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, exp: 4_102_444_800 })}.signature-value-long-enough`;
}

const publicSource = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project-ref.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_TEMPLATE_PUBLIC_VALUE_123456",
};

const serverSource = {
  ...publicSource,
  APP_ORIGIN: "https://app.example.com",
  AUTH_SIGNUP_MODE: "disabled" as const,
};

describe("public environment boundary", () => {
  it("accepts a publishable Supabase configuration", () => {
    expect(parsePublicEnvironment(publicSource)).toEqual(publicSource);
  });

  it("accepts the legacy anon JWT during Supabase key migration", () => {
    const legacyKey = jwt("anon");
    expect(readJwtRole(legacyKey)).toBe("anon");
    expect(parsePublicEnvironment({
      ...publicSource,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: legacyKey,
    }).NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).toBe(legacyKey);
  });

  it.each([
    ["missing URL", { ...publicSource, NEXT_PUBLIC_SUPABASE_URL: undefined }],
    ["credentialed URL", { ...publicSource, NEXT_PUBLIC_SUPABASE_URL: "https://user:pass@example.com" }],
    ["non-local HTTP URL", { ...publicSource, NEXT_PUBLIC_SUPABASE_URL: "http://example.com" }],
    ["malformed URL", { ...publicSource, NEXT_PUBLIC_SUPABASE_URL: "not-a-url-with-private-data" }],
  ])("fails clearly for %s without echoing values", (_label, source) => {
    expect(() => parsePublicEnvironment(source)).toThrow(EnvironmentConfigurationError);
    try {
      parsePublicEnvironment(source);
    } catch (error) {
      expect(String(error)).toContain("NEXT_PUBLIC_SUPABASE_URL");
      expect(String(error)).not.toContain("user:pass");
    }
  });

  it.each([
    ["sb", "secret", "NEVER_EXPOSE_THIS_VALUE_123456"].join("_"),
    "prefix-service_role-private-value",
    jwt("service_role"),
  ])("rejects a server-shaped client credential without echoing it", (secret) => {
    expect(() => parsePublicEnvironment({
      ...publicSource,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secret,
    })).toThrow(EnvironmentConfigurationError);

    try {
      parsePublicEnvironment({
        ...publicSource,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secret,
      });
    } catch (error) {
      expect(String(error)).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("server environment boundary", () => {
  it("keeps the service credential optional for the foundation", () => {
    expect(parseServerEnvironment(serverSource)).toEqual(serverSource);
  });

  it("accepts a secret key only through the server schema", () => {
    const serviceKey = ["sb", "secret", "SERVER_SCHEMA_VALUE_123456789"].join("_");
    expect(parseServerEnvironment({
      ...serverSource,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    }).SUPABASE_SERVICE_ROLE_KEY).toBe(serviceKey);
  });

  it("accepts a legacy JWT only when its role is service_role", () => {
    const serviceJwt = jwt("service_role");
    expect(parseServerEnvironment({
      ...serverSource,
      SUPABASE_SERVICE_ROLE_KEY: serviceJwt,
    }).SUPABASE_SERVICE_ROLE_KEY).toBe(serviceJwt);
  });

  it("rejects an anon JWT in the server credential slot", () => {
    expect(() => parseServerEnvironment({
      ...serverSource,
      SUPABASE_SERVICE_ROLE_KEY: jwt("anon"),
    })).toThrow("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("reports only the server variable name for invalid credentials", () => {
    const invalidValue = "not-a-server-key";
    expect(() => parseServerEnvironment({
      ...serverSource,
      SUPABASE_SERVICE_ROLE_KEY: invalidValue,
    })).toThrow("SUPABASE_SERVICE_ROLE_KEY");
    try {
      parseServerEnvironment({ ...serverSource, SUPABASE_SERVICE_ROLE_KEY: invalidValue });
    } catch (error) {
      expect(String(error)).not.toContain(invalidValue);
    }
  });

  it.each([
    ["missing signup mode", { ...serverSource, AUTH_SIGNUP_MODE: undefined }],
    ["implicit signup mode", { ...serverSource, AUTH_SIGNUP_MODE: "enabled" }],
    ["external HTTP origin", { ...serverSource, APP_ORIGIN: "http://example.com" }],
    ["origin with a path", { ...serverSource, APP_ORIGIN: "https://example.com/callback" }],
  ])("fails closed for %s", (_label, source) => {
    expect(() => parseServerEnvironment(source)).toThrow(EnvironmentConfigurationError);
  });
});
