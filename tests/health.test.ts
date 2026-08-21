import { describe, expect, it } from "vitest";
import { GET } from "@/app/health/route";

describe("health endpoint", () => {
  it("reports boundary readiness without returning environment values", async () => {
    const response = GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      checks: ["environment-boundary"],
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(body)).not.toContain("supabase.co");
    expect(JSON.stringify(body)).not.toContain("sb_publishable_");
  });

  it("fails closed with a generic response when runtime configuration is invalid", async () => {
    const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "not-a-url-with-private-data";
    try {
      const response = GET();
      expect(response.status).toBe(503);
      const responseText = await response.text();
      expect(JSON.parse(responseText)).toEqual({ status: "error", checks: [] });
      expect(responseText).not.toContain("private-data");
    } finally {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    }
  });
});
