import "server-only";

import { getServerEnvironment } from "@/lib/env/server";

export function getAuthConfiguration() {
  const environment = getServerEnvironment();
  return {
    applicationOrigin: environment.APP_ORIGIN,
    signupMode: environment.AUTH_SIGNUP_MODE,
  } as const;
}

export function getAuthCallbackUrl() {
  const { applicationOrigin } = getAuthConfiguration();
  return new URL("/auth/callback", applicationOrigin).toString();
}
