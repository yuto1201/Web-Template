import { EnvironmentConfigurationError } from "@/lib/env/error";
import { getServerEnvironment } from "@/lib/env/server";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    getServerEnvironment();
    return Response.json(
      { status: "ok", checks: ["environment-boundary"] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (!(error instanceof EnvironmentConfigurationError)) {
      throw error;
    }
    return Response.json(
      { status: "error", checks: [] },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
