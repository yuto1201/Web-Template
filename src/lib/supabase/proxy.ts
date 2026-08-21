import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getAuthConfiguration } from "@/lib/auth/config";
import { getPublicEnvironment } from "@/lib/env/public";
import type { Database } from "@/types/database.generated";

function copySessionResponse(target: NextResponse, source: NextResponse) {
  source.cookies.getAll().forEach((cookie) => target.cookies.set(cookie));
  for (const header of ["cache-control", "expires", "pragma", "vary"]) {
    const value = source.headers.get(header);
    if (value) {
      target.headers.set(header, value);
    }
  }
  return target;
}

export async function updateSupabaseSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const environment = getPublicEnvironment();
  const client = createServerClient<Database>(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
          Object.entries(headers ?? {}).forEach(([name, value]) => response.headers.set(name, value));
        },
      },
    },
  );

  // Keep this immediately after client creation: it verifies and refreshes the cookie JWT.
  const { data, error } = await client.auth.getClaims();
  if (request.nextUrl.pathname.startsWith("/account") && (error || !data?.claims?.sub)) {
    const { applicationOrigin } = getAuthConfiguration();
    const login = new URL("/login", applicationOrigin);
    login.searchParams.set("next", "/account");
    const redirect = copySessionResponse(NextResponse.redirect(login), response);
    redirect.headers.set("Cache-Control", "private, no-store");
    redirect.headers.set("Expires", "0");
    redirect.headers.set("Pragma", "no-cache");
    return redirect;
  }

  return response;
}
