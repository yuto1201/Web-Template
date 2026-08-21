import "server-only";

import { parseServerEnvironment } from "./server-schema";

export function getServerEnvironment() {
  const runtimeEnvironment = process.env;
  return parseServerEnvironment({
    NEXT_PUBLIC_SUPABASE_URL: runtimeEnvironment["NEXT_PUBLIC_SUPABASE_URL"],
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: runtimeEnvironment["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],
    APP_ORIGIN: runtimeEnvironment["APP_ORIGIN"],
    AUTH_SIGNUP_MODE: runtimeEnvironment["AUTH_SIGNUP_MODE"],
    SUPABASE_SERVICE_ROLE_KEY: runtimeEnvironment["SUPABASE_SERVICE_ROLE_KEY"],
  });
}
