import { NextResponse } from "next/server";
import { getAuthConfiguration } from "@/lib/auth/config";
import { applicationRedirect, sanitizeRedirectPath } from "@/lib/auth/redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function privateRedirect(url: URL) {
  return NextResponse.redirect(url, {
    headers: {
      "Cache-Control": "private, no-store",
      Expires: "0",
      Pragma: "no-cache",
    },
  });
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const nextPath = sanitizeRedirectPath(requestUrl.searchParams.get("next"));
  const code = requestUrl.searchParams.get("code");
  const { applicationOrigin } = getAuthConfiguration();

  if (code) {
    const client = await createSupabaseServerClient();
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (!error) {
      return privateRedirect(applicationRedirect(applicationOrigin, nextPath));
    }
  }

  const login = new URL("/login", applicationOrigin);
  login.searchParams.set("next", nextPath);
  login.searchParams.set("error", "auth_callback_failed");
  return privateRedirect(login);
}
