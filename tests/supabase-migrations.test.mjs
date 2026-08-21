// @vitest-environment node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = path.resolve("supabase", "migrations");

describe("Supabase migration policy", () => {
  it("uses pinned-CLI timestamped migration names", async () => {
    const migrations = (await readdir(migrationsDirectory))
      .filter((migration) => migration.endsWith(".sql"))
      .toSorted();
    expect(migrations.length).toBeGreaterThan(0);
    for (const migration of migrations) {
      expect(migration).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/u);
    }
    const timestamps = migrations.map((migration) => migration.slice(0, 14));
    expect(new Set(timestamps).size).toBe(timestamps.length);
  });

  it("pairs explicit authenticated grants with owner-scoped RLS", async () => {
    const sql = await readFile(path.join(migrationsDirectory, "20260821040140_create_owner_items.sql"), "utf8");
    expect(sql).toContain("alter table public.owner_items enable row level security");
    expect(sql).toContain("alter table public.owner_items force row level security");
    expect(sql).toContain("create index owner_items_owner_id_idx on public.owner_items (owner_id)");
    expect(sql).toContain("revoke all on table public.owner_items from public, anon, authenticated");
    expect(sql).toContain("grant select, delete on table public.owner_items to authenticated");
    expect(sql).toContain("grant insert (label) on table public.owner_items to authenticated");
    expect(sql).toContain("grant update (label) on table public.owner_items to authenticated");
    expect(sql.match(/create policy/gu)).toHaveLength(4);
    expect(sql.match(/\(select auth\.uid\(\)\) = owner_id/gu)).toHaveLength(5);
    expect(sql).not.toMatch(/security definer/iu);
  });

  it("keeps seed content synthetic and credential-free", async () => {
    const seed = await readFile(path.resolve("supabase", "seed.sql"), "utf8");
    expect(seed).toContain("synthetic");
    expect(seed).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/iu);
  });

  it("keeps browser and server factories on publishable configuration", async () => {
    const browser = await readFile(path.resolve("src", "lib", "supabase", "browser.ts"), "utf8");
    const server = await readFile(path.resolve("src", "lib", "supabase", "server.ts"), "utf8");
    expect(server.trimStart().startsWith('import "server-only";')).toBe(true);
    expect(`${browser}\n${server}`).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(`${browser}\n${server}`).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  });
});
