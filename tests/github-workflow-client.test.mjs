// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

const repository = "example/template";
const head = "a".repeat(40);
const old = "b".repeat(40);
const token = "fake-token-never-real";
const ref = `refs/notes/github-workflow/${"c".repeat(64)}`;
const issue = { number: 41, title: "Title", body: "Body\r\ntext", state: "open", updated_at: "2026-08-31T00:00:00Z", html_url: "https://github.com/example/template/issues/41" };
const pull = { number: 42, node_id: "PR_example", state: "open", draft: true, base: { ref: "main", repo: { full_name: repository } }, head: { ref: "codex/41-transport", sha: head, repo: { id: 123 } }, title: "PR", body: "Closes #41", html_url: "https://github.com/example/template/pull/42" };
/** @type {import('../tools/github-workflow-client.mjs').createGitHubWorkflowClient} */
let createClient;
/** @type {{command: string,args: string[],options: Record<string, any>}[]} */
let calls;
/** @type {Record<string, any>} */
let responses;
/** @type {((args: string[]) => Record<string, any>) | undefined} */
let gitResponse;
/** @type {string[]} */
let temporaryRoots;

/** @param {any} body @param {number} [status] @param {number} [exit] */
function http(body, status = 200, exit = 0) {
  return { status: exit, stdout: `HTTP/2.0 ${status} Result\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`, stderr: exit ? token : "" };
}

beforeEach(async () => {
  calls = [];
  responses = {
    user: { login: "example", id: 17, node_id: "U_example" },
    "repos/example/template": { owner: { login: "example" }, name: "template", id: 123, node_id: "R_example" },
    "repos/example/template/git/ref/heads/main": { ref: "refs/heads/main", object: { type: "commit", sha: head } },
    "repos/example/template/issues/41": issue,
    "repos/example/template/pulls/42": pull,
  };
  gitResponse = undefined;
  temporaryRoots = [];
  vi.mocked(spawnSync).mockImplementation(/** @type {any} */ ((/** @type {string} */ command, /** @type {string[]} */ args, /** @type {Record<string, any>} */ options) => {
    calls.push({ command, args, options });
    if (command === "git") return gitResponse?.(args) ?? { status: 0, stdout: "", stderr: "" };
    if (command !== "gh") throw new Error("Unexpected executable");
    if (args[0] === "auth") return { status: 0, stdout: `${token}\n`, stderr: "" };
    const endpoint = args.find((arg) => arg === "graphql" || arg === "user" || arg.startsWith("repos/"));
    const response = endpoint && responses[endpoint];
    if (!response) throw new Error(`Missing fake endpoint: ${endpoint}`);
    return "stdout" in response ? response : http(response);
  }));
  expect(existsSync(path.resolve("tools/github-workflow-client.mjs")), "fixed workflow client implementation must exist").toBe(true);
  ({ createGitHubWorkflowClient: createClient } = await import("../tools/github-workflow-client.mjs"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

/** @returns {string} */
function sourceRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "github-client-source-"));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
  return root;
}

describe("fixed GitHub workflow client", () => {
  it("normalizes observed identity and pins one token despite later ambient auth changes", async () => {
    vi.stubEnv("GH_TOKEN", "wrong-ambient");
    vi.stubEnv("GH_HOST", "attacker.invalid");
    vi.stubEnv("GH_DEBUG", "api");
    const client = createClient();
    vi.stubEnv("GH_TOKEN", "changed-ambient");
    expect(await client.observe(repository)).toEqual({ account: { login: "example", userId: 17, nodeId: "U_example" }, target: { owner: "example", repository: "template", repositoryId: 123, repositoryNodeId: "R_example" }, mainSha: head });
    await client.observe(repository);
    expect(calls.filter((call) => call.args[0] === "auth")).toHaveLength(1);
    for (const call of calls.filter((call) => call.args[0] === "api")) {
      expect(call.options.env.GH_TOKEN).toBe(token);
      expect(call.options.env.GH_HOST).toBe("github.com");
      expect(call.options.env.GH_DEBUG).toBeUndefined();
      expect(call.args).toContain("--hostname");
      expect(call.args.join(" ")).not.toContain(token);
    }
    expect(calls[0].args).toEqual(["auth", "token", "--hostname", "github.com"]);
    expect(calls[0].options.env.GH_TOKEN).toBeUndefined();
  });

  it("rejects wrong repository identity and malformed stable IDs", async () => {
    responses.user.id = "17";
    await expect(createClient().observe(repository)).rejects.toThrow();
    responses.user.id = 17;
    responses["repos/example/template"].name = "other";
    await expect(createClient().observe(repository)).rejects.toThrow();
  });

  it("normalizes issues and rejects PR objects returned through issue endpoints", async () => {
    const client = createClient();
    expect(await client.issue(repository, 41)).toEqual({ number: 41, title: "Title", body: "Body\r\ntext", state: "OPEN", updatedAt: "2026-08-31T00:00:00Z", url: issue.html_url });
    responses["repos/example/template/issues/41"] = { ...issue, pull_request: {} };
    await expect(client.issue(repository, 41)).rejects.toThrow();
  });

  it("returns null only for authenticated, parsed HTTP 404 branch responses", async () => {
    const endpoint = "repos/example/template/git/ref/heads/codex/41-transport";
    const client = createClient();
    responses[endpoint] = http({ message: "Not Found" }, 404, 1);
    expect(await client.branch(repository, "codex/41-transport")).toBeNull();
    for (const response of [http({}, 401, 1), http({}, 500, 1), { status: 1, stdout: "", stderr: "HTTP 404 " + token }, { status: null, stdout: "", error: new Error(token) }]) {
      responses[endpoint] = response;
      await expect(client.branch(repository, "codex/41-transport")).rejects.toThrow();
    }
    responses[endpoint] = { ref: "refs/heads/codex/41-transport", object: { type: "commit", sha: head } };
    expect(await client.branch(repository, "codex/41-transport")).toBe(head);
  });

  it("claims only the notes namespace, once, with exact returned ref and commit", async () => {
    responses["repos/example/template/git/refs"] = http({ ref, object: { type: "commit", sha: head } }, 201);
    const client = createClient();
    expect(await client.claim(repository, ref, head)).toEqual({ ref, sha: head });
    const call = calls.at(-1);
    expect(call?.args).toContain("POST");
    expect(JSON.parse(call?.options.input)).toEqual({ ref, sha: head });
    for (const invalid of ["refs/heads/main", `refs/notes/github-workflow/${"a".repeat(63)}`, `refs/notes/else/${"a".repeat(64)}`]) {
      await expect(client.claim(repository, invalid, head)).rejects.toThrow();
    }
    expect(calls.filter((entry) => entry.args.includes("POST"))).toHaveLength(1);
    responses["repos/example/template/git/refs"] = http({}, 422, 1);
    await expect(client.claim(repository, ref, head)).rejects.toThrow();
    expect(calls.filter((entry) => entry.args.includes("POST"))).toHaveLength(2);
    responses["repos/example/template/git/refs"] = http({ ref, object: { type: "commit", sha: old } }, 201);
    await expect(client.claim(repository, ref, head)).rejects.toThrow();
  });

  it("sends bounded create/update payloads without permitting PR base or state changes", async () => {
    responses["repos/example/template/issues"] = issue;
    responses["repos/example/template/pulls"] = pull;
    const client = createClient();
    await client.createIssue(repository, { title: "Title", body: "Body" });
    expect(JSON.parse(calls.at(-1)?.options.input)).toEqual({ title: "Title", body: "Body" });
    expect(await client.createPull(repository, { branch: "codex/41-transport", title: "PR", body: "Closes #41" })).toMatchObject({ state: "OPEN", draft: true, headRepositoryId: 123 });
    expect(JSON.parse(calls.at(-1)?.options.input)).toEqual({ head: "codex/41-transport", base: "main", draft: true, maintainer_can_modify: false, title: "PR", body: "Closes #41" });
    await client.updatePull(repository, 42, { title: "PR", body: "Closes #41" });
    expect(JSON.parse(calls.at(-1)?.options.input)).toEqual({ title: "PR", body: "Closes #41" });
    await expect(client.updatePull(repository, 42, /** @type {any} */ ({ title: "x", body: "y", base: "evil", state: "closed" }))).rejects.toThrow();
    await expect(client.createIssue(repository, { title: "x".repeat(257), body: "" })).rejects.toThrow();
  });

  it("preserves exact approved Issue and PR content through mutation and provider normalization", async () => {
    const title = "  Title  with double spaces  ";
    const body = "First  line\r\nSecond\tline\r\n";
    responses["repos/example/template/issues"] = { ...issue, title, body };
    responses["repos/example/template/issues/41"] = { ...issue, title, body };
    responses["repos/example/template/pulls"] = { ...pull, title, body };
    responses["repos/example/template/pulls/42"] = { ...pull, title, body };
    const client = createClient();
    expect(await client.createIssue(repository, { title, body })).toMatchObject({ title: "  Title  with double spaces  ", body: "First  line\r\nSecond\tline\r\n" });
    expect(JSON.parse(calls.at(-1)?.options.input)).toEqual({ title: "  Title  with double spaces  ", body: "First  line\r\nSecond\tline\r\n" });
    expect(await client.issue(repository, 41)).toMatchObject({ title: "  Title  with double spaces  ", body: "First  line\r\nSecond\tline\r\n" });
    expect(await client.createPull(repository, { branch: "codex/41-transport", title, body })).toMatchObject({ title: "  Title  with double spaces  ", body: "First  line\r\nSecond\tline\r\n" });
    expect(JSON.parse(calls.at(-1)?.options.input)).toMatchObject({ title: "  Title  with double spaces  ", body: "First  line\r\nSecond\tline\r\n" });
    expect(await client.updatePull(repository, 42, { title, body })).toMatchObject({ title: "  Title  with double spaces  ", body: "First  line\r\nSecond\tline\r\n" });
    expect(JSON.parse(calls.at(-1)?.options.input)).toEqual({ title: "  Title  with double spaces  ", body: "First  line\r\nSecond\tline\r\n" });
    expect(await client.pull(repository, 42)).toMatchObject({ title: "  Title  with double spaces  ", body: "First  line\r\nSecond\tline\r\n" });
  });

  it("rejects unsupported approved text before any Issue or PR API mutation", async () => {
    responses["repos/example/template/issues"] = issue;
    responses["repos/example/template/pulls"] = pull;
    const client = createClient();
    const invalid = [
      { title: "Title\u0000", body: "Body" }, { title: "Title\nline", body: "Body" },
      { title: "Title\rline", body: "Body" }, { title: "   ", body: "Body" },
      { title: "x".repeat(257), body: "Body" }, { title: "Title", body: "x".repeat(65_537) },
      ...["\u0000", "\u001b", "\u007f", "\u0085", "\u061c", "\u200e", "\u200f", "\u202e", "\u2066"].map((control) => ({ title: "Title", body: `Body${control}text` })),
    ];
    for (const input of invalid) {
      await expect(client.createIssue(repository, input)).rejects.toThrow();
      await expect(client.createPull(repository, { ...input, branch: "codex/41-transport" })).rejects.toThrow();
      await expect(client.updatePull(repository, 42, input)).rejects.toThrow();
    }
    expect(calls.filter((call) => call.args[0] === "api")).toHaveLength(0);
  });

  it("rejects provider content controls rather than hiding drift and permits empty read bodies", async () => {
    const client = createClient();
    responses["repos/example/template/issues/41"] = { ...issue, title: "Title\u0000" };
    await expect(client.issue(repository, 41)).rejects.toThrow();
    responses["repos/example/template/pulls/42"] = { ...pull, body: "Closes #41\u202e" };
    await expect(client.pull(repository, 42)).rejects.toThrow();
    responses["repos/example/template/issues/41"] = { ...issue, body: "" };
    responses["repos/example/template/pulls/42"] = { ...pull, body: null };
    expect((await client.issue(repository, 41)).body).toBe("");
    expect((await client.pull(repository, 42)).body).toBe("");
  });

  it("uses only the fixed ready mutation and rejects malformed GraphQL results", async () => {
    responses.graphql = { data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_example", isDraft: false } } } };
    const client = createClient();
    expect(await client.readyPull(repository, "PR_example")).toEqual({ nodeId: "PR_example", draft: false });
    const payload = JSON.parse(calls.at(-1)?.options.input);
    expect(payload.variables).toEqual({ id: "PR_example" });
    expect(payload.query).toContain("markPullRequestReadyForReview");
    responses.graphql.errors = [{ message: token }];
    await expect(client.readyPull(repository, "PR_example")).rejects.toThrow();
  });

  it("marks capped issue/PR lists and partial check sets incomplete", async () => {
    responses["repos/example/template/issues?state=open&per_page=100"] = Array.from({ length: 100 }, () => issue);
    responses["repos/example/template/pulls?state=open&base=main&head=example%3Acodex%2F41-transport&per_page=100"] = [pull];
    responses[`repos/example/template/commits/${head}/check-runs?per_page=100&filter=latest`] = { total_count: 2, check_runs: [{ name: "CI", status: "completed", conclusion: "success", head_sha: head }] };
    responses[`repos/example/template/commits/${head}/status?per_page=100`] = { sha: head, total_count: 1, statuses: [{ context: "required", state: "pending" }] };
    const client = createClient();
    expect((await client.listIssues(repository)).complete).toBe(false);
    expect((await client.findPull(repository, "codex/41-transport")).complete).toBe(true);
    expect(await client.pull(repository, 42)).toMatchObject({ number: 42, nodeId: "PR_example", baseBranch: "main", branch: "codex/41-transport", headSha: head });
    expect(await client.checks(repository, head)).toEqual({ headSha: head, checkRuns: [{ name: "CI", status: "completed", conclusion: "success" }], statuses: [{ context: "required", state: "pending" }], complete: false });
  });

  it("rejects arbitrary repositories, ref paths, malformed checks and wrong PR query results", async () => {
    const client = createClient();
    for (const invalid of ["../repos", "x/y/z", "https://evil/x", "x/y?redirect=x"]) await expect(client.observe(invalid)).rejects.toThrow();
    for (const invalid of ["main", "refs/heads/main", "codex/0-zero", "codex/41-x..y", "cursor/41-transport", "codex/41-x.lock"]) await expect(client.branch(repository, invalid)).rejects.toThrow();
    responses["repos/example/template/pulls?state=open&base=main&head=example%3Acodex%2F41-transport&per_page=100"] = [{ ...pull, head: { ...pull.head, ref: "claude/41-other" } }];
    await expect(client.findPull(repository, "codex/41-transport")).rejects.toThrow();
    responses[`repos/example/template/commits/${head}/check-runs?per_page=100&filter=latest`] = { total_count: 1, check_runs: [{ name: "CI", status: "completed", conclusion: "success", head_sha: old }] };
    await expect(client.checks(repository, head)).rejects.toThrow();
  });

  it("redacts provider stdout, stderr and execution errors", async () => {
    responses.user = { status: 1, stdout: token, stderr: token, error: new Error(token) };
    try { await createClient().observe(repository); expect.fail("must reject"); }
    catch (error) { expect(String(error)).not.toContain(token); expect(String(error)).toMatch(/sha256:[a-f0-9]{64}/u); }
  });

  it("does not accept an ambiguous 200 response as ownership of a create-only claim", async () => {
    responses["repos/example/template/git/refs"] = http({ ref, object: { type: "commit", sha: head } }, 200);
    await expect(createClient().claim(repository, ref, head)).rejects.toThrow();
    expect(calls.filter((call) => call.args.includes("POST"))).toHaveLength(1);
  });

  it("rejects successful provider responses containing the captured credential", async () => {
    responses["repos/example/template/issues/41"] = { ...issue, body: `Provider reflected ${token}` };
    await expect(createClient().issue(repository, 41)).rejects.toThrow();
  });

  it("pushes through isolated bare Git and shares only the frozen credential in ephemeral config", async () => {
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "url.https://attacker.invalid.insteadOf");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "https://github.com/");
    vi.stubEnv("GIT_TRACE", "1");
    vi.stubEnv("HTTPS_PROXY", "https://attacker.invalid");
    vi.stubEnv("GIT_SSH_COMMAND", "attacker");
    const root = sourceRoot();
    const client = createClient();
    await client.observe(repository);
    expect(await client.push({ root, repository, branch: "codex/41-transport", expectedHeadSha: old, headSha: head })).toEqual({ branch: "codex/41-transport", headSha: head });
    const gitCalls = calls.filter((call) => call.command === "git");
    const push = gitCalls.find((call) => call.args.includes("push"));
    expect(push?.args).toContain(`--force-with-lease=refs/heads/codex/41-transport:${old}`);
    expect(push?.args).toContain(`${head}:refs/heads/codex/41-transport`);
    expect(push?.args).toContain("https://github.com/example/template.git");
    expect(push?.options.cwd).not.toBe(root);
    expect(gitCalls.some((call) => call.args.includes("merge-base") && call.args.includes("--is-ancestor") && call.args.includes(old) && call.args.includes(head))).toBe(true);
    for (const call of gitCalls) {
      expect(call.args.join(" ")).not.toContain(token);
      expect(call.options.env.GIT_TRACE).toBeUndefined();
      expect(call.options.env.HTTPS_PROXY).toBeUndefined();
      expect(call.options.env.GIT_SSH_COMMAND).toBeUndefined();
      expect(JSON.stringify(call.options.env)).not.toContain("attacker.invalid");
      expect(call.options.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    }
    const config = new Map(Array.from({ length: Number(push?.options.env.GIT_CONFIG_COUNT) }, (_, i) => [push?.options.env[`GIT_CONFIG_KEY_${i}`], push?.options.env[`GIT_CONFIG_VALUE_${i}`]]));
    expect(config.get("http.https://github.com/.extraHeader")).toBe(`Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`);
    expect(config.get("http.followRedirects")).toBe("false");
    expect(config.get("credential.helper")).toBe("");
    expect(config.get("core.hooksPath")).toBeTruthy();
    expect(calls.filter((call) => call.args[0] === "auth")).toHaveLength(1);
    expect(existsSync(push?.options.cwd)).toBe(false);
  });

  it("rejects history rewrites before push even with a CAS lease", async () => {
    const root = sourceRoot();
    gitResponse = (args) => ({ status: args.includes("merge-base") ? 1 : 0, stdout: "", stderr: token });
    await expect(createClient().push({ root, repository, branch: "claude/41-safe", expectedHeadSha: old, headSha: head })).rejects.toThrow();
    expect(calls.some((call) => call.args.includes("push"))).toBe(false);
  });

  it("also rejects unsafe arguments at the internal Git module boundary", async () => {
    const { pushGitHubWorkflowBranch } = await import("../tools/github-workflow-git.mjs");
    const input = { root: sourceRoot(), repository, branch: "claude/41-safe", expectedHeadSha: null, headSha: head, token };
    expect(() => pushGitHubWorkflowBranch({ ...input, branch: "main" })).toThrow();
    expect(() => pushGitHubWorkflowBranch({ ...input, repository: "attacker.invalid/path?q=x" })).toThrow();
    expect(() => pushGitHubWorkflowBranch({ ...input, headSha: "HEAD" })).toThrow();
    expect(calls.some((call) => call.command === "git")).toBe(false);
  });

  it("uses an empty exact lease for new branch creation and rejects unsafe push branches", async () => {
    const root = sourceRoot();
    const client = createClient();
    await client.push({ root, repository, branch: "claude/41-safe", expectedHeadSha: null, headSha: head });
    expect(calls.find((call) => call.args.includes("push"))?.args).toContain("--force-with-lease=refs/heads/claude/41-safe:");
    const count = calls.length;
    await expect(client.push({ root, repository, branch: "main", expectedHeadSha: null, headSha: head })).rejects.toThrow();
    expect(calls.length).toBe(count);
  });

  it("resolves linked worktree objects without reading caller Git config", async () => {
    const shared = sourceRoot();
    const worktree = mkdtempSync(path.join(os.tmpdir(), "github-client-worktree-"));
    temporaryRoots.push(worktree);
    const metadata = path.join(shared, ".git", "worktrees", "example");
    mkdirSync(metadata, { recursive: true });
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${metadata}\n`);
    writeFileSync(path.join(metadata, "commondir"), "../..\n");
    writeFileSync(path.join(shared, ".git", "config"), "[url \"https://attacker.invalid/\"]\n\tinsteadOf = https://github.com/\n");
    await createClient().push({ root: worktree, repository, branch: "claude/41-safe", expectedHeadSha: null, headSha: head });
    const push = calls.find((call) => call.args.includes("push"));
    expect(JSON.parse(push?.options.env.GIT_ALTERNATE_OBJECT_DIRECTORIES)).toBe(realpathSync(path.join(shared, ".git", "objects")));
    expect(calls.filter((call) => call.command === "git").every((call) => call.options.cwd !== worktree && call.options.cwd !== shared)).toBe(true);
  });

  it("quotes object database paths instead of rejecting valid separator characters", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(path.join(os.tmpdir(), "github-client:quoted-"));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
    await createClient().push({ root, repository, branch: "claude/41-safe", expectedHeadSha: null, headSha: head });
    const push = calls.find((call) => call.args.includes("push"));
    expect(push?.options.env.GIT_ALTERNATE_OBJECT_DIRECTORIES.startsWith('"')).toBe(true);
  });

  it("keeps incomplete Link pages incomplete, excludes PRs, and accepts complete check evidence", async () => {
    responses["repos/example/template/issues?state=open&per_page=100"] = { ...http([issue, { ...issue, pull_request: {} }]), stdout: `HTTP/2.0 200 OK\r\nLink: <https://api.github.com/next>; rel="next"\r\n\r\n${JSON.stringify([issue, { ...issue, pull_request: {} }])}` };
    responses[`repos/example/template/commits/${head}/check-runs?per_page=100&filter=latest`] = { total_count: 1, check_runs: [{ name: "CI", status: "completed", conclusion: "success", head_sha: head }] };
    responses[`repos/example/template/commits/${head}/status?per_page=100`] = { sha: head, total_count: 0, statuses: [] };
    const client = createClient();
    const list = await client.listIssues(repository);
    expect(list.items).toHaveLength(1);
    expect(list.complete).toBe(false);
    expect((await client.checks(repository, head)).complete).toBe(true);
  });
});
