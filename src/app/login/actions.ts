"use server";

import { redirect } from "next/navigation";
import { getAuthCallbackUrl, getAuthConfiguration } from "@/lib/auth/config";
import { sanitizeRedirectPath } from "@/lib/auth/redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function field(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function passwordField(formData: FormData) {
  const value = formData.get("password");
  return typeof value === "string" ? value : "";
}

function loginLocation(nextPath: string, key: "error" | "notice", value: string) {
  const parameters = new URLSearchParams({ next: sanitizeRedirectPath(nextPath), [key]: value });
  return `/login?${parameters.toString()}` as const;
}

export async function loginAction(formData: FormData) {
  const email = field(formData, "email");
  const password = passwordField(formData);
  const nextPath = sanitizeRedirectPath(field(formData, "next"));
  if (!email || email.length > 254 || password.length < 8 || password.length > 512) {
    redirect(loginLocation(nextPath, "error", "invalid_credentials"));
  }

  const client = await createSupabaseServerClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    redirect(loginLocation(nextPath, "error", "invalid_credentials"));
  }
  redirect(nextPath);
}

export async function signupAction(formData: FormData) {
  const nextPath = sanitizeRedirectPath(field(formData, "next"));
  const { signupMode } = getAuthConfiguration();
  if (signupMode !== "public") {
    redirect(loginLocation(nextPath, "error", "signup_disabled"));
  }

  const email = field(formData, "email");
  const password = passwordField(formData);
  if (!email || email.length > 254 || password.length < 8 || password.length > 512) {
    redirect(loginLocation(nextPath, "error", "invalid_signup"));
  }

  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: getAuthCallbackUrl() },
  });
  if (error) {
    redirect(loginLocation(nextPath, "error", "signup_failed"));
  }
  if (data.session) {
    redirect(nextPath);
  }
  redirect(loginLocation(nextPath, "notice", "check_email"));
}
