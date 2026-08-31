import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** @param {unknown} detail */
function failure(detail) {
  return new Error(`Isolated Git workflow request failed (sha256:${createHash("sha256").update(String(detail)).digest("hex")}).`);
}

/**
 * Resolve only Git's directory-pointer files, without loading any source configuration.
 * Worktrees point .git to their worktree directory and commondir to the shared objects.
 * @param {string} root
 */
function sourceObjects(root) {
  let directory = path.join(realpathSync(root), ".git");
  if (statSync(directory).isFile()) {
    const pointer = readFileSync(directory, "utf8");
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(pointer);
    if (!match) throw failure("Invalid Git directory pointer");
    directory = path.resolve(path.dirname(directory), match[1]);
  }
  directory = realpathSync(directory);
  try {
    const common = readFileSync(path.join(directory, "commondir"), "utf8").trim();
    if (!common || /[\r\n\u0000]/u.test(common)) throw failure("Invalid Git common directory");
    directory = realpathSync(path.resolve(directory, common));
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const objects = realpathSync(path.join(directory, "objects"));
  if (!statSync(objects).isDirectory() || /[\u0000-\u001f\u007f]/u.test(objects)) {
    throw failure("Invalid object directory");
  }
  return objects;
}

/**
 * Internal transport only. Recheck its narrow inputs even when called outside the API wrapper.
 * The credential is never written to disk, passed as argv, or exposed in the result.
 * @param {{root:string,repository:string,branch:string,expectedHeadSha:string|null,headSha:string,token:string}} input
 */
export function pushGitHubWorkflowBranch({ root, repository, branch, expectedHeadSha, headSha, token }) {
  let temporary;
  try {
    if (typeof root !== "string" || !root ||
      typeof repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/u.test(repository) || repository.includes("..") || repository.endsWith(".git") ||
      typeof branch !== "string" || branch.length > 200 || !/^(?:codex|claude)\/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(branch) ||
      typeof headSha !== "string" || !/^[0-9a-f]{40}$/u.test(headSha) ||
      (expectedHeadSha !== null && (typeof expectedHeadSha !== "string" || !/^[0-9a-f]{40}$/u.test(expectedHeadSha))) ||
      typeof token !== "string" || token.length > 4096 || !/^[\x21-\x7e]+$/u.test(token)) {
      throw failure("Invalid isolated Git input");
    }
    const objects = sourceObjects(root);
    temporary = mkdtempSync(path.join(os.tmpdir(), "github-workflow-push-"));
    const bare = path.join(temporary, "repository.git");
    const hooks = path.join(temporary, "empty-hooks");
    mkdirSync(hooks);
    /** @type {Record<string, string | undefined>} */
    const environment = {};
    for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
      if (process.env[key]) environment[key] = process.env[key];
    }
    Object.assign(environment, {
      HOME: temporary,
      USERPROFILE: temporary,
      XDG_CONFIG_HOME: temporary,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(temporary, "absent-global-config"),
      GIT_CONFIG_SYSTEM: path.join(temporary, "absent-system-config"),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_NO_REPLACE_OBJECTS: "1",
      // Git accepts C-style quoted alternates, including Windows backslashes and colons.
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects),
      LC_ALL: "C",
    });
    const configuration = [
      ["core.hooksPath", hooks],
      ["core.askPass", ""],
      ["credential.helper", ""],
      ["credential.interactive", "false"],
      ["http.followRedirects", "false"],
      ["http.proxy", ""],
      ["http.sslVerify", "true"],
      ["protocol.allow", "never"],
      ["protocol.https.allow", "always"],
      ["push.followTags", "false"],
      ["push.recurseSubmodules", "no"],
      ["gc.auto", "0"],
      ["maintenance.auto", "false"],
    ];
    /** @param {boolean} authenticated */
    function gitEnvironment(authenticated) {
      const entries = authenticated
        ? [...configuration, ["http.https://github.com/.extraHeader", `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`]]
        : configuration;
      /** @type {Record<string, string | undefined>} */
      const env = { ...environment, GIT_CONFIG_COUNT: String(entries.length) };
      entries.forEach(([key, value], index) => {
        env[`GIT_CONFIG_KEY_${index}`] = key;
        env[`GIT_CONFIG_VALUE_${index}`] = value;
      });
      return { ...env, NODE_ENV: /** @type {const} */ ("production") };
    }
    /** @param {string[]} args @param {boolean} [authenticated] @param {string} [cwd] */
    function git(args, authenticated = false, cwd = bare) {
      const result = spawnSync("git", args, {
        cwd, env: gitEnvironment(authenticated), encoding: "utf8", windowsHide: true,
        timeout: 120_000, maxBuffer: 2 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
      });
      if (result.status !== 0 || result.error || result.signal) {
        throw failure(`${result.status}:${result.signal}:${result.error?.message}:${result.stdout}:${result.stderr}`);
      }
    }
    git(["init", "--bare", "--template=", bare], false, temporary);
    git(["cat-file", "-e", `${headSha}^{commit}`]);
    if (expectedHeadSha !== null) {
      git(["cat-file", "-e", `${expectedHeadSha}^{commit}`]);
      // A lease is CAS, not a fast-forward guarantee. Prove ancestry separately.
      git(["merge-base", "--is-ancestor", expectedHeadSha, headSha]);
    }
    const reference = `refs/heads/${branch}`;
    git([
      "push", "--porcelain", "--no-verify", "--no-follow-tags", "--recurse-submodules=no",
      `--force-with-lease=${reference}:${expectedHeadSha ?? ""}`,
      "--", `https://github.com/${repository}.git`, `${headSha}:${reference}`,
    ], true);
    return { branch, headSha };
  } catch (error) {
    throw failure(error instanceof Error ? error.message : error);
  } finally {
    // Only our own unique temporary directory is removed; source refs/config stay untouched.
    if (temporary) {
      try { rmSync(temporary, { recursive: true, force: true }); }
      catch { /* It contains no credentials; cleanup failure cannot cause a push retry. */ }
    }
  }
}
