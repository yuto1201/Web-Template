import { z } from "zod";
import { EnvironmentConfigurationError } from "./error";
import { parsePublicEnvironment, readJwtRole, type PublicEnvironment } from "./public-schema";

const serviceRoleSchema = z.string().trim().superRefine((value, context) => {
  const isSecretKey = /^sb_secret_[A-Za-z0-9_-]{16,}$/u.test(value);
  const isLegacyServiceRoleJwt = readJwtRole(value) === "service_role";
  if (!isSecretKey && !isLegacyServiceRoleJwt) {
    context.addIssue({ code: "custom", message: "Expected a server-only Supabase credential." });
  }
});

const appOriginSchema = z.string().trim().url().superRefine((value, context) => {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    context.addIssue({ code: "custom", message: "Use HTTPS, except for a local application origin." });
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    context.addIssue({ code: "custom", message: "Expected an origin without credentials, path, query, or fragment." });
  }
});

const signupModeSchema = z.enum(["disabled", "public"]);

export type ServerEnvironment = PublicEnvironment & {
  APP_ORIGIN: string;
  AUTH_SIGNUP_MODE: "disabled" | "public";
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

export function parseServerEnvironment(source: Record<string, string | undefined>): ServerEnvironment {
  const publicEnvironment = parsePublicEnvironment({
    NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  const authConfiguration = z.object({
    APP_ORIGIN: appOriginSchema,
    AUTH_SIGNUP_MODE: signupModeSchema,
  }).safeParse({
    APP_ORIGIN: source.APP_ORIGIN,
    AUTH_SIGNUP_MODE: source.AUTH_SIGNUP_MODE,
  });
  if (!authConfiguration.success) {
    throw new EnvironmentConfigurationError("server", authConfiguration.error.issues);
  }
  const serviceRole = source.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceRole) {
    return { ...publicEnvironment, ...authConfiguration.data };
  }

  const result = serviceRoleSchema.safeParse(serviceRole);
  if (!result.success) {
    throw new EnvironmentConfigurationError("server", result.error.issues.map((issue) => ({
      ...issue,
      path: ["SUPABASE_SERVICE_ROLE_KEY"],
    })));
  }
  return { ...publicEnvironment, ...authConfiguration.data, SUPABASE_SERVICE_ROLE_KEY: result.data };
}
