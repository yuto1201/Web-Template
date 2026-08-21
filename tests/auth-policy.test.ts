import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { applicationRedirect, sanitizeRedirectPath } from "@/lib/auth/redirect";
import { parseServerEnvironment } from "@/lib/env/server-schema";

describe("authentication policy", () => {
  it.each([undefined, null, "", "https://evil.example/account", "//evil.example/account", "/account?next=evil", "/unknown", "/account\\evil"])(
    "rejects a non-allowlisted redirect: %s",
    (value) => expect(sanitizeRedirectPath(value)).toBe("/account"),
  );

  it.each(["/", "/account"] as const)("accepts the approved application path %s", (path) => {
    expect(sanitizeRedirectPath(path)).toBe(path);
    expect(applicationRedirect("https://app.example.com", path).origin).toBe("https://app.example.com");
  });

  it("requires an explicit sign-up mode and exact application origin", () => {
    expect(parseServerEnvironment({
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_TEMPLATE_AUTH_VALUE_123456",
      APP_ORIGIN: "https://app.example.com",
      AUTH_SIGNUP_MODE: "public",
    }).AUTH_SIGNUP_MODE).toBe("public");
  });

  it("keeps server authorization on verified claims rather than local session metadata", async () => {
    const claims = await readFile("src/lib/auth/claims.ts", "utf8");
    const proxy = await readFile("src/lib/supabase/proxy.ts", "utf8");
    expect(`${claims}\n${proxy}`).toContain("auth.getClaims()");
    expect(`${claims}\n${proxy}`).not.toContain("auth.getSession()");
    expect(`${claims}\n${proxy}`).not.toContain("user_metadata");
    expect(proxy).toContain("request.cookies.set");
    expect(proxy).toContain("response.cookies.set");
    expect(proxy).toContain("Object.entries(headers ?? {})");
    expect(proxy).toContain("NextResponse.next({ request })");
  });

  it("builds callback redirects from the configured origin rather than request headers", async () => {
    const callback = await readFile("src/app/auth/callback/route.ts", "utf8");
    expect(callback).toContain("applicationOrigin");
    expect(callback).toContain("applicationRedirect(applicationOrigin, nextPath)");
    expect(callback).not.toContain("headers().get");
    expect(callback).not.toContain("x-forwarded-host");
  });

  it("keeps the public sign-up server action fail-closed", async () => {
    const actions = await readFile("src/app/login/actions.ts", "utf8");
    const provider = await readFile("supabase/config.toml", "utf8");
    const globalAuthSection = provider.match(/^\[auth\]\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/mu)?.[1];
    expect(actions).toContain('signupMode !== "public"');
    expect(actions).toContain('"signup_disabled"');
    expect(globalAuthSection).toMatch(/^enable_signup = false$/mu);
  });
});
