import { describe, expect, it } from "vitest";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { createSupabaseServerClient } from "@/lib/supabase/server";

describe("Supabase public client factories", () => {
  it("creates a typed browser client from publishable configuration", () => {
    const client = createSupabaseBrowserClient();
    expect(client.from).toBeTypeOf("function");
  });

  it("creates a new server client per cookie adapter without a secret key", () => {
    const cookieAdapter = {
      getAll: () => [],
      setAll: () => undefined,
    };
    const first = createSupabaseServerClient(cookieAdapter);
    const second = createSupabaseServerClient(cookieAdapter);

    expect(first).not.toBe(second);
    expect(first.from).toBeTypeOf("function");
  });
});
