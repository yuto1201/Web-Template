export type ApprovedRedirectPath = "/" | "/account";

const approvedPaths = new Set<ApprovedRedirectPath>(["/", "/account"]);
const parsingOrigin = "https://redirect.invalid";

export function sanitizeRedirectPath(
  value: string | null | undefined,
  fallback: ApprovedRedirectPath = "/account",
): ApprovedRedirectPath {
  if (!approvedPaths.has(fallback)) {
    throw new Error("The redirect fallback must be an approved application path.");
  }
  if (!value || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    return fallback;
  }

  try {
    const parsed = new URL(value, parsingOrigin);
    if (parsed.origin !== parsingOrigin || !approvedPaths.has(parsed.pathname as ApprovedRedirectPath)) {
      return fallback;
    }
    return parsed.pathname as ApprovedRedirectPath;
  } catch {
    return fallback;
  }
}

export function applicationRedirect(origin: string, path: ApprovedRedirectPath) {
  return new URL(sanitizeRedirectPath(path), origin);
}
