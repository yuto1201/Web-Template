import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supabaseCli = path.join(repositoryRoot, "node_modules", "supabase", "dist", "supabase.js");
const excludedServices = [
  "realtime",
  "storage-api",
  "imgproxy",
  "mailpit",
  "postgres-meta",
  "studio",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
].join(",");

/** @param {string} output */
function sanitize(output) {
  return output
    .replaceAll(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/gu, "<redacted-local-key>")
    .replaceAll(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu, "<redacted-local-jwt>")
    .replaceAll(/(SERVICE_ROLE_KEY|ANON_KEY|JWT_SECRET|SECRET_KEY|PUBLISHABLE_KEY)=[^\s]+/giu, "$1=<redacted>")
    .replaceAll(/("(?:SERVICE_ROLE_KEY|ANON_KEY|JWT_SECRET|SECRET_KEY|PUBLISHABLE_KEY)"\s*:\s*")[^"]+("?)/giu, "$1<redacted>$2");
}

/** @param {string} command @param {string[]} args @param {string} label */
function run(command, args, label) {
  console.warn(`[auth-integration] ${label}`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = sanitize(`${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`).trim();
    throw new Error(`${label} failed.${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout;
}

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {string} url @param {string} publishableKey */
function client(url, publishableKey) {
  return createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

/**
 * @param {string} url
 * @param {string} publishableKey
 * @param {Map<string, string>} cookieJar
 * @param {Map<string, string>} [responseHeaders]
 */
function cookieClient(url, publishableKey, cookieJar, responseHeaders = new Map()) {
  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return [...cookieJar].map(([name, value]) => ({ name, value }));
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => cookieJar.set(name, value));
        Object.entries(headers ?? {}).forEach(([name, value]) => responseHeaders.set(name.toLowerCase(), value));
      },
    },
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} authClient
 * @param {string} email
 * @param {string} password
 */
async function signIn(authClient, email, password) {
  const { data, error } = await authClient.auth.signInWithPassword({ email, password });
  if (error || !data.user || !data.session?.access_token) {
    throw new Error(`Local Auth did not issue the expected signed-in user session (${error?.code ?? "missing_session"}).`);
  }
  const claims = await authClient.auth.getClaims();
  assert(!claims.error && claims.data?.claims?.sub === data.user.id, "The local JWT claims were not verified.");
  return { user: data.user, session: data.session };
}

const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  windowsHide: true,
});

if (docker.error || docker.status !== 0) {
  const message = "Auth integration NOT RUN: a reachable Docker daemon is required.";
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(`::error title=Auth integration NOT RUN::${message}`);
  }
  process.exitCode = 2;
} else {
  let startAttempted = false;
  try {
    startAttempted = true;
    run(process.execPath, [supabaseCli, "start", "--exclude", excludedServices, "--yes"], "start Auth and Data API services");
    run(process.execPath, [supabaseCli, "db", "reset", "--local", "--yes"], "reset Auth integration database");
    const status = JSON.parse(run(process.execPath, [supabaseCli, "status", "-o", "json"], "read ephemeral local endpoints"));
    assert(typeof status.API_URL === "string", "Local API URL is unavailable.");
    assert(typeof status.PUBLISHABLE_KEY === "string", "Local publishable key is unavailable.");
    assert(typeof status.SECRET_KEY === "string", "Local admin key is unavailable.");

    const firstClient = client(status.API_URL, status.PUBLISHABLE_KEY);
    const secondClient = client(status.API_URL, status.PUBLISHABLE_KEY);
    const adminClient = client(status.API_URL, status.SECRET_KEY);
    const deniedSignup = await firstClient.auth.signUp({
      email: "direct-signup@example.invalid",
      password: "synthetic-direct-signup",
    });
    assert(Boolean(deniedSignup.error), "The deny-by-default provider unexpectedly allowed public signup.");
    for (const [email, password] of [
      ["auth-one@example.invalid", "synthetic-password-one"],
      ["auth-two@example.invalid", "synthetic-password-two"],
    ]) {
      const created = await adminClient.auth.admin.createUser({ email, password, email_confirm: true });
      assert(!created.error, "The local admin could not create a synthetic test user.");
    }
    const firstIdentity = await signIn(firstClient, "auth-one@example.invalid", "synthetic-password-one");
    await signIn(secondClient, "auth-two@example.invalid", "synthetic-password-two");

    const cookieJar = new Map();
    const responseHeaders = new Map();
    const sessionWriter = cookieClient(status.API_URL, status.PUBLISHABLE_KEY, cookieJar, responseHeaders);
    const sessionResult = await sessionWriter.auth.setSession({
      access_token: firstIdentity.session.access_token,
      refresh_token: firstIdentity.session.refresh_token,
    });
    assert(!sessionResult.error && cookieJar.size > 0, "The SSR client did not persist the JWT session in cookies.");
    const cookiesBeforeRefresh = JSON.stringify([...cookieJar]);
    responseHeaders.clear();
    const requestClient = cookieClient(status.API_URL, status.PUBLISHABLE_KEY, cookieJar, responseHeaders);
    const refresh = await requestClient.auth.refreshSession();
    assert(!refresh.error, "The request-scoped SSR client could not rotate its refresh token.");
    assert(JSON.stringify([...cookieJar]) !== cookiesBeforeRefresh, "Refresh did not rotate the SSR cookie session.");
    assert(
      responseHeaders.get("cache-control")?.includes("no-store"),
      "Refresh did not provide a no-store response header.",
    );
    const refreshedRequestClient = cookieClient(status.API_URL, status.PUBLISHABLE_KEY, cookieJar);
    const requestClaims = await refreshedRequestClient.auth.getClaims();
    assert(
      !requestClaims.error && requestClaims.data?.claims?.sub === firstIdentity.user.id,
      "The request-scoped SSR cookie client did not verify the JWT subject.",
    );

    const inserted = await refreshedRequestClient
      .from("owner_items")
      .insert({ label: "JWT-owned integration row" })
      .select("id,owner_id,label")
      .single();
    assert(!inserted.error, "The first authenticated user could not insert an owner row.");
    assert(inserted.data?.owner_id === firstIdentity.user.id, "The database did not derive ownership from auth.uid().");

    const otherRows = await secondClient.from("owner_items").select("id,owner_id,label");
    assert(!otherRows.error && otherRows.data?.length === 0, "A second JWT could read another user's row.");

    const forgedInsert = await secondClient
      .from("owner_items")
      .insert({ owner_id: firstIdentity.user.id, label: "forged owner" });
    assert(Boolean(forgedInsert.error), "A second JWT could forge another user's ownership.");

    const ownRows = await refreshedRequestClient.from("owner_items").select("id,owner_id,label");
    assert(!ownRows.error && ownRows.data?.length === 1, "The first JWT lost access to its owner row.");
    console.warn("Auth/JWT/RLS integration verification passed.");
  } catch (error) {
    console.error(sanitize(error instanceof Error ? error.message : "Auth integration failed."));
    process.exitCode = 1;
  } finally {
    if (startAttempted) {
      try {
        run(process.execPath, [supabaseCli, "stop", "--no-backup"], "stop isolated Auth integration stack");
      } catch (error) {
        console.error(sanitize(error instanceof Error ? error.message : "Auth integration cleanup failed."));
        process.exitCode = 1;
      }
    }
  }
}
