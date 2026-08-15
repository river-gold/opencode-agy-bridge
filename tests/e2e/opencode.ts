import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

const FIRST = "FIRST_REQUEST_MARKER";
const SECOND = "SECOND_REQUEST_MARKER";
const ABORT = "ABORT_REQUEST_MARKER";
const THIRD = "THIRD_REQUEST_MARKER";
const AUTO_MODEL = "AUTO_MODEL_REQUEST_MARKER";
const TITLE_REQUEST = "Generate a title for this conversation:";
const FIRST_OUTPUT = "E2E_FIRST_OUTPUT";
const SECOND_OUTPUT = "E2E_SECOND_OUTPUT";
const THIRD_OUTPUT = "E2E_THIRD_OUTPUT";
const AUTO_MODEL_OUTPUT = "E2E_AUTO_MODEL_OUTPUT";
const TITLE_OUTPUT = "E2E_TITLE_OUTPUT";
const MAIN_CONVERSATION = "mock-conversation-1";
const AUTO_CONVERSATION = "mock-conversation-auto";
const TITLE_CONVERSATION = "mock-conversation-title";
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
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const fileExists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
async function waitForFile(path: string, attempts = 100): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await fileExists(path)) return true;
    await sleep(100);
  }
  return false;
}

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
const abortStart = join(root, "abort-start");
const abortComplete = join(root, "abort-complete");
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
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "models") {
  console.log("auto-model-high\\tAuto Model (High)\\nauto-model-low\\tAuto Model (Low)\\ne2e-model\\tE2E model");
  process.exit(0);
}
appendFileSync(process.env.E2E_AGY_LOG, JSON.stringify({ cwd: process.cwd(), argv: args }) + "\\n");
if (!args.includes("--output-format") || !args.includes("stream-json")) process.exit(41);
const prompt = args[args.indexOf("-p") + 1] ?? "";
if (prompt.includes("${ABORT}") && !prompt.includes("${THIRD}")) {
  writeFileSync(process.env.E2E_AGY_ABORT_START, "");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  writeFileSync(process.env.E2E_AGY_ABORT_COMPLETE, "");
  console.log(JSON.stringify({ event: "init", conversation_id: "${MAIN_CONVERSATION}" }));
  console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "${ABORT}", state: "DONE", conversation_id: "${MAIN_CONVERSATION}" } }));
  console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "${ABORT}", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, conversation_id: "${MAIN_CONVERSATION}" } }));
  process.exit(0);
}
if (!prompt.includes("${TITLE_REQUEST}") && !prompt.includes("${FIRST}") && !prompt.includes("${SECOND}") && !prompt.includes("${THIRD}") && !prompt.includes("${AUTO_MODEL}")) process.exit(42);
const title = prompt.includes("${TITLE_REQUEST}");
const auto = prompt.includes("${AUTO_MODEL}");
const output = title ? "${TITLE_OUTPUT}" : auto ? "${AUTO_MODEL_OUTPUT}" : prompt.includes("${THIRD}") ? "${THIRD_OUTPUT}" : prompt.includes("${SECOND}") ? "${SECOND_OUTPUT}" : "${FIRST_OUTPUT}";
const conversation = title ? "${TITLE_CONVERSATION}" : auto ? "${AUTO_CONVERSATION}" : "${MAIN_CONVERSATION}";
console.log(JSON.stringify({ event: "init", conversation_id: conversation }));
console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: output, state: "DONE", conversation_id: conversation } }));
console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, conversation_id: conversation } }));
`, "utf8");
  await chmod(mock, 0o755);
  const configContent = JSON.stringify({
    plugin: [pathToFileURL(join(repoRoot, "dist/plugin.js")).href],
    enabled_providers: ["agy"],
    provider: { agy: {
      npm: pathToFileURL(join(repoRoot, "dist/index.js")).href,
      name: "agy E2E",
      options: { binary: mock, conversationsDir, stateFile, timeoutMs: 5_000 },
    } },
    agent: { title: { model: "agy/e2e-model" } },
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
     E2E_AGY_ABORT_START: abortStart, E2E_AGY_ABORT_COMPLETE: abortComplete,
    OPENCODE_LOG_LEVEL: "DEBUG", OPENCODE_PRINT_LOGS: "1", LANG: process.env.LANG ?? "C.UTF-8", TMPDIR: root,
  };
  await writeFile(invocationLog, "", "utf8");
  server = spawn(join(repoRoot, "node_modules/.bin/opencode"), ["serve", "--hostname=127.0.0.1", "--port=0"], { cwd: serverCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const baseUrl = await waitForServer(server, logs);
  const auth = Buffer.from(`${env.OPENCODE_SERVER_USERNAME}:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
  const client = createOpencodeClient({ baseUrl, directory: workspace, headers: { Authorization: `Basic ${auth}` } });
   const created = await client.session.create({ body: {}, signal: AbortSignal.timeout(10_000) });
  assert.ok(created.data, `session was not created (${created.response.status}): ${JSON.stringify(created.error ?? {})}`);
  const sessionID = created.data.id;
  const prompt = (text: string) => client.session.prompt({ path: { id: sessionID }, body: { model: { providerID: "agy", modelID: "e2e-model" }, parts: [{ type: "text", text }] }, signal: AbortSignal.timeout(10_000) });
   const first = await prompt(FIRST);
   assert.ok(first.data, "first response was empty");
   assert.equal(textOf(first.data), FIRST_OUTPUT, JSON.stringify(first.data));

   let lastTitle: string | undefined;
   let titleReady = false;
   const titleDeadline = Date.now() + 10_000;
   for (let remaining = 10_000; remaining >= 0; remaining = titleDeadline - Date.now()) {
     const session = await client.session.get({ path: { id: sessionID }, signal: AbortSignal.timeout(10_000) });
     lastTitle = session.data?.title;
     if (lastTitle === TITLE_OUTPUT) {
       titleReady = true;
       break;
     }
     const waitMs = titleDeadline - Date.now();
     if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(100, waitMs)));
   }
   if (!titleReady) assert.fail(`session title was not generated within 10 seconds; last title: ${lastTitle ?? "<none>"}`);

   const second = await prompt(SECOND);
   assert.ok(second.data, "second response was empty");
   assert.equal(textOf(second.data), SECOND_OUTPUT);
   const invocations = (await readFile(invocationLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Invocation);
   assert.equal(invocations.length, 3);
   for (const invocation of invocations) {
     assert.equal(invocation.cwd, workspace);
     assert.notEqual(invocation.cwd, serverCwd);
     assert.equal(invocation.argv[invocation.argv.indexOf("--add-dir") + 1], workspace);
     assert.equal(invocation.argv[invocation.argv.indexOf("--model") + 1], "e2e-model");
     assert.ok(invocation.argv.includes("--dangerously-skip-permissions"));
   }
   const promptOf = (invocation: Invocation) => invocation.argv[invocation.argv.indexOf("-p") + 1] ?? "";
   const titleMatches = invocations.filter((invocation) => promptOf(invocation).includes(TITLE_REQUEST));
   const firstMatches = invocations.filter((invocation) =>
     promptOf(invocation).includes(FIRST) && !promptOf(invocation).includes(TITLE_REQUEST) && !promptOf(invocation).includes(SECOND),
   );
   const secondMatches = invocations.filter((invocation) => promptOf(invocation).includes(SECOND));
   assert.equal(titleMatches.length, 1);
   assert.equal(firstMatches.length, 1);
   assert.equal(secondMatches.length, 1);
   const titleInvocation = titleMatches[0];
   const firstInvocation = firstMatches[0];
   const secondInvocation = secondMatches[0];
   assert.ok(titleInvocation);
   assert.ok(firstInvocation);
   assert.ok(secondInvocation);
   assert.equal(titleInvocation.argv.includes("--conversation"), false);
   const titlePrompt = promptOf(titleInvocation);
   assert.match(titlePrompt, new RegExp(TITLE_REQUEST));
   assert.match(titlePrompt, new RegExp(FIRST));
   assert.doesNotMatch(titlePrompt, new RegExp(SECOND));
   assert.equal(firstInvocation.argv.includes("--conversation"), false);
   assert.equal(secondInvocation.argv[secondInvocation.argv.indexOf("--conversation") + 1], MAIN_CONVERSATION);
   const secondPrompt = promptOf(secondInvocation);
   assert.match(secondPrompt, new RegExp(SECOND));
   assert.doesNotMatch(secondPrompt, new RegExp(`${FIRST}|${FIRST_OUTPUT}`));
   const session = await client.session.get({ path: { id: sessionID }, signal: AbortSignal.timeout(10_000) });
   assert.ok(session.data, "session was not found");
   assert.equal(session.data.title, TITLE_OUTPUT);
   const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { sessions: Record<string, { conversationId: string | null }> };
   assert.deepEqual(Object.keys(persisted.sessions).sort(), [sessionID, `${sessionID}:title`].sort());
    assert.equal(persisted.sessions[sessionID]?.conversationId, MAIN_CONVERSATION);
    assert.equal(persisted.sessions[`${sessionID}:title`]?.conversationId, TITLE_CONVERSATION);

    const abort = await client.session.promptAsync({
      path: { id: sessionID },
      body: { model: { providerID: "agy", modelID: "e2e-model" }, parts: [{ type: "text", text: ABORT }] },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(abort.response.status, 204);
    assert.equal(await waitForFile(abortStart), true, "abort did not start");

    let busy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const statuses = await client.session.status({ signal: AbortSignal.timeout(10_000) });
      if (statuses.data?.[sessionID]?.type === "busy") {
        busy = true;
        break;
      }
      await sleep(100);
    }
    assert.equal(busy, true, "session did not become busy during abort");

    const abortResponse = await client.session.abort({ path: { id: sessionID }, signal: AbortSignal.timeout(10_000) });
    assert.equal(abortResponse.response.status, 200);
    assert.equal(abortResponse.data, true);

    let stopped = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const statuses = await client.session.status({ signal: AbortSignal.timeout(10_000) });
      const type = statuses.data?.[sessionID]?.type;
      if (type === undefined || type === "idle") {
        stopped = true;
        break;
      }
      await sleep(100);
    }
    assert.equal(stopped, true, "session did not stop after abort");
    assert.equal(server.exitCode, null);
    assert.equal(server.signalCode, null);
    assert.equal(await fileExists(abortComplete), false, "aborted process completed");

    const third = await prompt(THIRD);
    assert.ok(third.data, "third response was empty");
    assert.equal(textOf(third.data), THIRD_OUTPUT);
    const afterAbortInvocations = (await readFile(invocationLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Invocation);
    const thirdInvocation = afterAbortInvocations.find((invocation) => promptOf(invocation).includes(THIRD));
    assert.ok(thirdInvocation);
    assert.equal(thirdInvocation.argv[thirdInvocation.argv.indexOf("--conversation") + 1], MAIN_CONVERSATION);

    const autoSession = await client.session.create({ body: {}, signal: AbortSignal.timeout(10_000) });
    assert.ok(autoSession.data, `auto model session was not created (${autoSession.response.status}): ${JSON.stringify(autoSession.error ?? {})}`);
    const autoSessionID = autoSession.data.id;
    const autoResponse = await client.session.prompt({
      path: { id: autoSessionID },
      body: {
        model: { providerID: "agy", modelID: "auto-model" },
        parts: [{ type: "text", text: AUTO_MODEL }],
      },
      signal: AbortSignal.timeout(10_000),
    });
    assert.ok(autoResponse.data, "auto model response was empty");
    assert.equal(textOf(autoResponse.data), AUTO_MODEL_OUTPUT, JSON.stringify(autoResponse.data));

    const finalInvocations = (await readFile(invocationLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Invocation);
    const autoInvocation = finalInvocations.find((invocation) =>
      promptOf(invocation).includes(AUTO_MODEL) &&
      invocation.argv[invocation.argv.indexOf("--model") + 1] === "auto-model",
    );
    assert.ok(autoInvocation, "auto model invocation was not found");
    assert.equal(autoInvocation.cwd, workspace);
    assert.notEqual(autoInvocation.cwd, serverCwd);
    assert.equal(autoInvocation.argv[autoInvocation.argv.indexOf("--add-dir") + 1], workspace);
    assert.equal(autoInvocation.argv[autoInvocation.argv.indexOf("--model") + 1], "auto-model");
    assert.equal(autoInvocation.argv.includes("--effort"), false, "argv must not contain --effort when effort is unspecified");
    assert.ok(autoInvocation.argv.includes("--dangerously-skip-permissions"));
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
