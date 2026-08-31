import { NextResponse, type NextRequest } from "next/server";
import { updateSupabaseSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  // These static public documents never inspect or refresh an authentication session.
  // Match only the exact routes; protected routes keep their existing checks.
  if (request.nextUrl.pathname === "/terms" || request.nextUrl.pathname === "/privacy") {
    return NextResponse.next();
  }
  return updateSupabaseSession(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
