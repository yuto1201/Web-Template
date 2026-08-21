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

export type ServerEnvironment = PublicEnvironment & {
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

export function parseServerEnvironment(source: Record<string, string | undefined>): ServerEnvironment {
  const publicEnvironment = parsePublicEnvironment({
    NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  const serviceRole = source.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceRole) {
    return publicEnvironment;
  }

  const result = serviceRoleSchema.safeParse(serviceRole);
  if (!result.success) {
    throw new EnvironmentConfigurationError("server", result.error.issues.map((issue) => ({
      ...issue,
      path: ["SUPABASE_SERVICE_ROLE_KEY"],
    })));
  }
  return { ...publicEnvironment, SUPABASE_SERVICE_ROLE_KEY: result.data };
}
