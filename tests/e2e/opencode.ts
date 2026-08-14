import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

const FIRST = "FIRST_REQUEST_MARKER";
const SECOND = "SECOND_REQUEST_MARKER";
const FIRST_OUTPUT = "E2E_FIRST_OUTPUT";
const SECOND_OUTPUT = "E2E_SECOND_OUTPUT";
const LOG_LIMIT = 12_000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

if (process.platform === "win32") {
  console.log("SKIP: OpenCode agy E2E is unsupported on Windows");
  process.exit(0);
}

type Invocation = { cwd: string; argv: string[] };
let redactions: string[] = [];
const redact = (text: string) => redactions.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), text);
const bounded = (text: string) => {
  const redacted = redact(text);
  return redacted.length <= LOG_LIMIT ? redacted : `${redacted.slice(-LOG_LIMIT)}\n[logs truncated]`;
};
const textOf = (response: { parts: Array<{ type?: string; text?: string }> }) =>
  response.parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");

function waitForServer(child: ChildProcess, logs: string[]): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`OpenCode server did not start. Logs:\n${bounded(logs.join(""))}`)), 15_000);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      logs.push(text);
      output += text;
      const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[0]);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`OpenCode server failed to spawn: ${error.message}\nLogs:\n${bounded(logs.join(""))}`));
    });
    child.once("exit", (code, signal) => {
      if (code !== null || signal !== null) {
        clearTimeout(timer);
        reject(new Error(`OpenCode server exited before startup (${code ?? signal}). Logs:\n${bounded(logs.join(""))}`));
      }
    });
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); done(true); });
  });
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (await waitForExit(child, 0)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 3_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, 3_000))) throw new Error("OpenCode server did not exit after SIGKILL");
}

const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-agy-e2e-")));
const home = join(root, "home");
const config = join(root, "config");
const data = join(root, "data");
const state = join(root, "state");
const cache = join(root, "cache");
const serverCwd = join(root, "server-cwd");
const workspace = join(root, "workspace");
const conversationsDir = join(root, "conversations");
const stateFile = join(root, "sessions.json");
const invocationLog = join(root, "agy-invocations.ndjson");
const mock = join(root, "mock-agy.mjs");
let server: ChildProcess | undefined;
const logs: string[] = [];

try {
  await Promise.all([home, config, data, state, cache, serverCwd, workspace, conversationsDir].map((path) => mkdir(path, { recursive: true })));
  const gitInit = spawnSync("git", ["init", "-q", workspace], { stdio: "ignore" });
  assert.equal(gitInit.status, 0, "git init failed");
  const gitStatus = spawnSync("git", ["-C", workspace, "status", "--porcelain"], { encoding: "utf8" });
  assert.equal(gitStatus.status, 0, "git status failed");
  assert.equal(gitStatus.stdout, "", "workspace must start with a clean git status");
  await writeFile(mock, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.E2E_AGY_LOG, JSON.stringify({ cwd: process.cwd(), argv: args }) + "\\n");
if (args[0] === "models" || !args.includes("--output-format") || !args.includes("stream-json")) process.exit(41);
const prompt = args[args.indexOf("-p") + 1] ?? "";
if (!prompt.includes("${FIRST}") && !prompt.includes("${SECOND}")) process.exit(42);
const output = prompt.includes("${SECOND}") ? "${SECOND_OUTPUT}" : "${FIRST_OUTPUT}";
const conversation = "mock-conversation-1";
console.log(JSON.stringify({ event: "init", conversation_id: conversation }));
console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: output, status: "ACTIVE", conversation_id: conversation } }));
console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: output, status: "DONE", conversation_id: conversation } }));
console.log(JSON.stringify({ event: "result", conversation_id: conversation, result: { status: "SUCCESS", response: output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }));
`, "utf8");
  await chmod(mock, 0o755);
  const configContent = JSON.stringify({
    plugin: [pathToFileURL(join(repoRoot, "dist/plugin.js")).href],
    enabled_providers: ["agy"],
    provider: { agy: {
      npm: pathToFileURL(join(repoRoot, "dist/index.js")).href,
      name: "agy E2E",
      options: { binary: mock, conversationsDir, stateFile, timeoutMs: 5_000 },
      models: { "e2e-model": { name: "E2E model", limit: { context: 8_192, output: 1_024 } } },
    } },
    agent: { title: { disable: true } },
    autoupdate: false, compaction: { auto: false }, snapshot: false, share: "disabled", lsp: false, formatter: false,
  });
  const serverUsername = `e2e-${randomBytes(12).toString("hex")}`;
  const serverPassword = randomBytes(24).toString("hex");
  redactions = [serverUsername, serverPassword];
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", OPENCODE_TEST_HOME: home, HOME: home, XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data, XDG_STATE_HOME: state, XDG_CACHE_HOME: cache,
    OPENCODE_CONFIG_CONTENT: configContent, OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_SERVER_PASSWORD: serverPassword,
    OPENCODE_SERVER_USERNAME: serverUsername, E2E_AGY_LOG: invocationLog,
    OPENCODE_LOG_LEVEL: "DEBUG", OPENCODE_PRINT_LOGS: "1", LANG: process.env.LANG ?? "C.UTF-8", TMPDIR: root,
  };
  await writeFile(invocationLog, "", "utf8");
  server = spawn(join(repoRoot, "node_modules/.bin/opencode"), ["serve", "--hostname=127.0.0.1", "--port=0"], { cwd: serverCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const baseUrl = await waitForServer(server, logs);
  const auth = Buffer.from(`${env.OPENCODE_SERVER_USERNAME}:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
  const client = createOpencodeClient({ baseUrl, directory: workspace, headers: { Authorization: `Basic ${auth}` } });
  const created = await client.session.create({ body: { title: "agy E2E session" }, signal: AbortSignal.timeout(10_000) });
  assert.ok(created.data, `session was not created (${created.response.status}): ${JSON.stringify(created.error ?? {})}`);
  const sessionID = created.data.id;
  const prompt = (text: string) => client.session.prompt({ path: { id: sessionID }, body: { model: { providerID: "agy", modelID: "e2e-model" }, parts: [{ type: "text", text }] }, signal: AbortSignal.timeout(10_000) });
  const first = await prompt(FIRST);
  assert.ok(first.data, "first response was empty");
  assert.equal(textOf(first.data), FIRST_OUTPUT, JSON.stringify(first.data));
  const second = await prompt(SECOND);
  assert.ok(second.data, "second response was empty");
  assert.equal(textOf(second.data), SECOND_OUTPUT);
  const invocations = (await readFile(invocationLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Invocation);
  assert.equal(invocations.length, 2);
  for (const invocation of invocations) {
    assert.equal(invocation.cwd, workspace);
    assert.notEqual(invocation.cwd, serverCwd);
    assert.equal(invocation.argv[invocation.argv.indexOf("--add-dir") + 1], workspace);
    assert.equal(invocation.argv[invocation.argv.indexOf("--model") + 1], "e2e-model");
    assert.ok(invocation.argv.includes("--dangerously-skip-permissions"));
  }
  assert.equal(invocations[0].argv.includes("--conversation"), false);
  assert.equal(invocations[1].argv[invocations[1].argv.indexOf("--conversation") + 1], "mock-conversation-1");
  const secondPrompt = invocations[1].argv[invocations[1].argv.indexOf("-p") + 1] ?? "";
  assert.match(secondPrompt, new RegExp(SECOND));
  assert.doesNotMatch(secondPrompt, new RegExp(`${FIRST}|${FIRST_OUTPUT}`));
  const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { sessions: Record<string, unknown> };
  assert.deepEqual(Object.keys(persisted.sessions), [sessionID]);
  console.log("OpenCode agy E2E passed");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const logDir = join(data, "opencode", "log");
  const logFiles = await readdir(logDir).catch(() => [] as string[]);
  const fileLogs = (await Promise.all(logFiles.map((file) => readFile(join(logDir, file), "utf8")))).join("\n");
  const mockLogs = await readFile(invocationLog, "utf8").catch(() => "");
  throw new Error(`${redact(message)}\nMock invocations:\n${bounded(mockLogs)}\nOpenCode logs:\n${bounded(`${logs.join("")}\n${fileLogs}`)}`);
} finally {
  if (server) await stopServer(server);
  await rm(root, { recursive: true, force: true });
}
