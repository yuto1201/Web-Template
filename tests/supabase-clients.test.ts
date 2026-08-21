import { describe, expect, it, vi } from "vitest";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { createSupabaseServerClient } from "@/lib/supabase/server";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    getAll: () => [],
    set: vi.fn(),
  })),
}));

describe("Supabase public client factories", () => {
  it("creates a typed browser client from publishable configuration", () => {
    const client = createSupabaseBrowserClient();
    expect(client.from).toBeTypeOf("function");
  });

  it("creates a new request-scoped server client without a secret key", async () => {
    const first = await createSupabaseServerClient();
    const second = await createSupabaseServerClient();

    expect(first).not.toBe(second);
    expect(first.from).toBeTypeOf("function");
  });
});
