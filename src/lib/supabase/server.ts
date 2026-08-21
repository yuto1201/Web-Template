import "server-only";

import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPublicEnvironment } from "@/lib/env/public";
import type { Database } from "@/types/database.generated";

export function createSupabaseServerClient(
  cookies: CookieMethodsServer,
): SupabaseClient<Database> {
  const environment = getPublicEnvironment();
  return createServerClient<Database>(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { cookies },
  );
}
