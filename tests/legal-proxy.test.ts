import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function withoutProviderConfiguration() {
  for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "APP_ORIGIN", "AUTH_SIGNUP_MODE"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubGlobal("fetch", () => { throw new Error("Unexpected provider request"); });
}

describe("public legal document boundary", () => {
  it.each(["/terms", "/privacy", "/terms?next=/account", "/privacy?next=/account"])(
    "serves %s without provider configuration or session refresh",
    async (pathname) => {
      withoutProviderConfiguration();
      const request = new NextRequest(`https://site.example${pathname}`, {
        headers: { cookie: "sb-example-auth-token=invalid-session" },
      });
      const response = await proxy(request);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("location")).toBeNull();
      expect(response.cookies.getAll()).toEqual([]);
    },
  );

  it.each(["/account", "/account/terms", "/terms/account", "/privacy-settings"])(
    "does not broaden the provider-free exemption to %s",
    async (pathname) => {
      withoutProviderConfiguration();
      await expect(proxy(new NextRequest(`https://site.example${pathname}`))).rejects.toThrow();
    },
  );
});
