import { z } from "zod";
import { EnvironmentConfigurationError } from "./error";

const publishablePrefix = /^sb_publishable_[A-Za-z0-9_-]{16,}$/u;
const secretPrefix = /^sb_secret_/iu;

export function readJwtRole(value: string): string | null {
  const payload = value.split(".")[1];
  if (!payload) {
    return null;
  }

  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded));
    return typeof parsed.role === "string" ? parsed.role : null;
  } catch {
    return null;
  }
}

const supabaseUrlSchema = z.string().trim().url().superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.username || url.password || url.hash) {
    context.addIssue({ code: "custom", message: "URL credentials and fragments are not allowed." });
  }
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    context.addIssue({ code: "custom", message: "Use HTTPS, except for a local Supabase URL." });
  }
});

const publishableKeySchema = z.string().trim().superRefine((value, context) => {
  const role = readJwtRole(value);
  if (secretPrefix.test(value) || role === "service_role" || value.toLowerCase().includes("service_role")) {
    context.addIssue({ code: "custom", message: "A server credential cannot be browser-visible." });
    return;
  }
  if (!publishablePrefix.test(value) && role !== "anon") {
    context.addIssue({ code: "custom", message: "Expected a Supabase publishable key or legacy anon JWT." });
  }
});

const publicEnvironmentSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrlSchema,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishableKeySchema,
}).strict();

export type PublicEnvironment = z.infer<typeof publicEnvironmentSchema>;

export function parsePublicEnvironment(source: Record<string, string | undefined>): PublicEnvironment {
  const result = publicEnvironmentSchema.safeParse(source);
  if (!result.success) {
    throw new EnvironmentConfigurationError("public", result.error.issues);
  }
  return result.data;
}
