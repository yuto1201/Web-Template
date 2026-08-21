import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supabaseCli = path.join(repositoryRoot, "node_modules", "supabase", "dist", "supabase.js");
const excludedServices = [
  "gotrue",
  "realtime",
  "storage-api",
  "imgproxy",
  "kong",
  "mailpit",
  "postgrest",
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
    .replaceAll(/sb_secret_[A-Za-z0-9_-]+/gu, "<redacted-local-secret>")
    .replaceAll(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu, "<redacted-local-jwt>")
    .replaceAll(/(SERVICE_ROLE_KEY|ANON_KEY|JWT_SECRET)=[^\s]+/giu, "$1=<redacted>");
}

/** @param {string} command @param {string[]} args @param {string} label */
function run(command, args, label) {
  console.warn(`[database] ${label}`);
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

const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  windowsHide: true,
});

if (docker.error || docker.status !== 0) {
  const message = "Database verification NOT RUN: a reachable Docker daemon is required.";
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(`::error title=Database verification NOT RUN::${message}`);
  }
  process.exitCode = 2;
} else {
  let started = false;
  try {
    run(process.execPath, [supabaseCli, "start", "--exclude", excludedServices, "--yes"], "start isolated local Postgres");
    started = true;
    run(process.execPath, [supabaseCli, "db", "reset", "--local", "--yes"], "reset from empty migrations");
    run(process.execPath, [supabaseCli, "db", "lint", "--local", "--schema", "public", "--level", "warning", "--fail-on", "warning"], "lint public schema");
    run(process.execPath, [supabaseCli, "test", "db", "--local"], "run pgTAP policy tests");

    const generated = run(
      process.execPath,
      [supabaseCli, "gen", "types", "--local", "--schema", "public"],
      "generate database types",
    ).replaceAll("\r\n", "\n").trimEnd();
    const committedPath = path.join(repositoryRoot, "src", "types", "database.generated.ts");
    const committed = (await readFile(committedPath, "utf8")).replaceAll("\r\n", "\n").trimEnd();
    if (generated !== committed) {
      throw new Error("generated database types differ from src/types/database.generated.ts");
    }
    console.warn("Database verification passed.");
  } catch (error) {
    console.error(sanitize(error instanceof Error ? error.message : "Database verification failed."));
    process.exitCode = 1;
  } finally {
    if (started) {
      try {
        run(process.execPath, [supabaseCli, "stop", "--no-backup"], "stop isolated local Postgres");
      } catch (error) {
        console.error(sanitize(error instanceof Error ? error.message : "Database cleanup failed."));
        process.exitCode = 1;
      }
    }
  }
}
