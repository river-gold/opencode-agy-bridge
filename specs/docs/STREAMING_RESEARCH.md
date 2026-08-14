# Streaming Research — Antigravity LanguageServer reverse engineering

Notes from investigating real-streaming alternatives for the agy plugin.
**Status:** confirmed protocol surface; not yet implemented. Kept as starting point for a future v2.

---

## TL;DR

`agy --print` buffers the full response. PTY does not help (tested with `script(1)`,
output jumps from 0 → N bytes after ~5 s).

However, the Antigravity **IDE** binary (`/opt/Antigravity IDE/.../language_server_linux_x64`)
hosts a Connect/gRPC-JSON server on two localhost ports that DOES stream. The
service is `exa.language_server_pb.LanguageServerService`, originally from Codeium
(rebranded as Windsurf → Antigravity).

The plugin could in principle bypass `agy --print` entirely and speak to a
language_server instance directly — either the one the IDE already runs, or one
the plugin spawns itself.

---

## Discovered surface

### Ports & processes

Inspecting a running Antigravity IDE:

```
$ ss -tlnp | grep language_server
LISTEN ... 127.0.0.1:46821 ... language_server (HTTPS / Connect gRPC, "lsp")
LISTEN ... 127.0.0.1:34169 ... language_server (HTTPS / Connect-JSON,  "https")
LISTEN ... 127.0.0.1:33665 ... antigravity-ide (HTTP,                  "extension_server")
```

Process command line carries the secrets:

```
language_server_linux_x64
  --enable_lsp
  --csrf_token <UUID>                       ← header value for the JSON server
  --extension_server_port 33665
  --extension_server_csrf_token <UUID>      ← header value for extension_server
  --https_server_port 34169                 ← Connect-JSON gateway
  --lsp_port 46821                          ← Connect-gRPC (HTTP/2)
  --workspace_id file_home_raul_workspace_rust_opencode_agy_bridge
  --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com
  --subclient_type ide
```

Lifecycle: if the language_server dies, the IDE supervisor respawns it within
~1 s, with the **same ports** but **new CSRF tokens**. So if the plugin depended
on this, it would have to re-read `ps` / `/proc/<pid>/cmdline` after each
unexpected `Exit`.

### Protocol

The HTTPS port (34169 here) is a **Connect-Web JSON gateway**:

| | |
|---|---|
| URL | `https://localhost:<https_server_port>/exa.language_server_pb.LanguageServerService/<Method>` |
| Verb | `POST` |
| Content-Type | `application/json` |
| Auth header | `x-codeium-csrf-token: <csrf_token from cmdline>` |
| Body | JSON encoding of the request proto (empty `{}` works for some methods) |
| TLS | Self-signed; clients must skip verification (`curl -k`) |

The lsp port (46821) responds to plain HTTP/2 too (returns plain "404 page not
found" on `/`), suggesting it accepts both Connect-gRPC and plain HTTP/2. Not
deeply explored.

### Confirmed working RPC calls

All on `https://localhost:<https_server_port>` with correct CSRF header:

| Method | Body | Response |
|---|---|---|
| `Exit` | `{}` | `200 {}` (kills the server; IDE respawns it) |
| `FetchUserInfo` | `{}` | `200 {"userSettings":{}}` |
| `GetStatus` | `{}` | `200 {}` |
| `GetAuthStatus` | `{}` | `400 {"code":"failed_precondition","message":"failed_precondition"}` (needs login state) |
| `HandleCascadeUserInteraction` | `{}` | `500 {"code":"unknown","message":"run state not found"}` — handler reached, needs an existing cascade run |

CSRF failure is `401 {"code":"unauthenticated","message":"invalid CSRF token"}`.
Unknown method is `404` (sometimes with empty body, depending on port).

### Method catalog (from `strings` over the binary)

Internal name: **Cascade** = the Antigravity agent ("agy" is the CLI; cascade is
the engine). Methods on `exa.language_server_pb.LanguageServerService` that look
relevant:

```
HandleCascadeUserInteraction              ← post user prompt
StreamCascadeReactiveUpdates              ← STREAMING response (server-stream)
StreamCascadeSummariesReactiveUpdates     ← STREAMING summaries
StreamAgentStateUpdates                   ← STREAMING agent state changes
StreamAudioTranscription                  ← STREAMING audio
CancelCascadeInvocation                   ← interrupt a running cascade
WaitForConversationFullyIdle              ← block until done
GetConversationMetadata
GetCascadeTrajectoryGeneratorMetadata
GetCascadeTrajectoryExecutorMetadatas
ResolveOutstandingSteps
GetAllCustomAgentConfigs
GetAllPlugins
CreateProject / UpdateProject / DeleteProject
FetchUserInfo / GetUserStatus / GetAuthStatus
Heartbeat / GetStatus / Exit
ManageSidecar / MigrateApiKey
ReconnectExtensionServer
```

Additional services in the same binary (may be relevant):

- `exa.api_server_pb.ApiServerService` (`RecordDebounce`, etc.)
- `exa.opensearch_clients_pb.KnowledgeBaseService`
- `exa.model_management_pb.ModelManagementService`
- `exa.seat_management_pb.SeatManagementService`
- `exa.extension_server_pb.ExtensionServerService` (talks to the IDE UI)
- `google.internal.cloud.code.v1internal.JetskiService` — the upstream Google
  gRPC service the local server proxies to:
  - `streamGenerateChat`
  - `streamGenerateContent`
  - `generateChat` / `generateContent`
  - `listModelConfigs`
  - `loadCodeAssist`
  - `retrieveUserQuota`
  - `fetchUserInfo`
  - `tabChat`
  - …

So the architecture is:
```
opencode plugin
   └─ Connect-JSON over HTTPS to localhost:<https_port>
       └─ language_server (Antigravity binary, written in Go)
           └─ gRPC to daily-cloudcode-pa.googleapis.com
               └─ Gemini model server
```

### text_drip evidence (proof streaming exists internally)

The log file `~/.gemini/antigravity-cli/log/cli-*.log` shows entries from
`text_drip.go:173` like:

```
Drip stopped: lastStepIdx=102, charIdx=84, length=382
```

confirming that the binary maintains a token-by-token drip controller. The `--print`
CLI path drains it to stdout in one go; the cascade RPCs presumably stream it.

### Known unknowns (blockers to implementing v2)

1. **Run-state creation flow.** `HandleCascadeUserInteraction` requires an
   already-existing run state. Need to find the method that creates a new
   cascade conversation (candidates not yet tested:
   `CreateConversation`, `StartCascade`, something via `GetCascadeTrajectory…`).
2. **Request/response proto definitions.** Empty `{}` worked for a few methods,
   but cascade methods will need real fields (workspace, user prompt content,
   conversation id, model selection, …). No `.proto` files ship with the
   binary. Two options:
   - **Capture live traffic** between the IDE and its own language_server
     (localhost mitmproxy with custom TLS root, or LD_PRELOAD-based syscall
     interception, or eBPF). Once we have one good `HandleCascadeUserInteraction`
     request, the fields self-document.
   - **Extract proto descriptors from the binary.** Go binaries often embed
     compressed `FileDescriptorProto`s for reflection. `strings -tx` over the
     binary plus a Go-aware tool like
     [`gostringsr2`](https://github.com/atc0005/gostringsr2) /
     [`protoreflect`](https://pkg.go.dev/google.golang.org/protobuf/reflect/protoreflect)
     could recover them.
3. **Authentication scope.** Local CSRF is sufficient to call the local RPCs;
   the local server uses its own stored OAuth credentials to talk to
   `daily-cloudcode-pa.googleapis.com`. We don't need to handle Google auth
   ourselves as long as the IDE (or a separately launched language_server) is
   logged in.
4. **Server lifecycle.** The plugin would have to:
   - Either rely on the IDE running (and read csrf + port from `ps`).
   - Or spawn a private language_server (the binary takes `--csrf_token`,
     `--https_server_port`, etc. as args, so we can launch it with known values).
     This needs `agy install` / `language_server` to be on PATH and an
     authenticated state at `~/.gemini/antigravity-cli/`.

---

## Possible implementation paths for a future v2

### Path 1: Piggyback on the IDE (cheapest)
- Plugin requires the user to keep Antigravity IDE running.
- On each turn:
  - Find `language_server_linux_x64` PID via `ps`.
  - Parse `/proc/<pid>/cmdline` to extract `--csrf_token` and `--https_server_port`.
  - POST `HandleCascadeUserInteraction` then read `StreamCascadeReactiveUpdates`
    server-stream as Connect-Web SSE.
- **Pros**: zero extra processes, real streaming.
- **Cons**: requires the IDE GUI to be open; resets on every IDE restart;
  taking over the IDE's cascade conversations might confuse the GUI.

### Path 2: Spawn our own language_server (cleaner)
- Plugin spawns the binary as a child with known csrf/ports, e.g.:
  ```
  language_server_linux_x64 \
    --csrf_token <generated> \
    --https_server_port <random> \
    --lsp_port <random> \
    --extension_server_port <random> \
    --extension_server_csrf_token <generated> \
    --workspace_id <stable id> \
    --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com \
    --subclient_type ide      # or whatever subclient is needed
  ```
- Wait for the "listening on …" log lines, then talk Connect-JSON to it.
- Reuse `~/.gemini/antigravity-cli/` for credentials.
- **Pros**: no IDE dependency, full lifecycle control.
- **Cons**: more args to discover; the binary may refuse to start without an
  `antigravity-ide` PID env or extra files; ToS implications.

### Path 3: Traffic capture only (research, no product)
- Sniff IDE↔language_server traffic to fully reverse-engineer the proto.
- Produce a `.proto` file + a small Go/TS client.
- Decide later between Path 1 and Path 2.

---

## Effort estimate

| Phase | Estimate |
|---|---|
| Capture one working HandleCascadeUserInteraction + StreamCascadeReactiveUpdates | 1–2 days |
| Recover proto schema from binary or traffic | 2–3 days |
| TS client for Connect-JSON stream | 1 day |
| Plugin integration & state machine (run state, cancel, restart) | 2–3 days |
| Tests & robustness (IDE restart, version drift, auth refresh) | 2 days |
| **Total to a usable v2 with streaming** | **~2 weeks** |

vs. ~30 minutes for the current `--print`-based v1 with a single `text-delta`.

---

## Risks

- **ToS / license.** Antigravity IDE is closed-source; bypassing the CLI and
  speaking directly to its internal gRPC may violate the EULA. Check before
  shipping.
- **Version brittleness.** Internal proto fields and method names can change
  silently between IDE releases.
- **Auth scope.** The same OAuth token covers `agy --print` and our direct
  calls. Quota accounting may flag unusual traffic patterns.
- **Workspace conflicts.** If both the IDE and our spawned server are running,
  they may step on each other's `~/.gemini/antigravity-cli/conversations/*.pb`.

---

## Reproducing the discovery (commands log)

```bash
# 1. Find the language_server process and ports
ss -tlnp | grep language_server
ps aux | grep language_server_linux | grep -v grep

# 2. Extract CSRF token from cmdline
ps -ef | grep language_server | grep -oE -- '--csrf_token [a-f0-9-]+'

# 3. Test basic methods
CSRF=<token-from-step-2>
PORT=<from --https_server_port>
curl -sk -X POST \
  -H "Content-Type: application/json" \
  -H "x-codeium-csrf-token: $CSRF" \
  --data '{}' \
  "https://localhost:$PORT/exa.language_server_pb.LanguageServerService/FetchUserInfo"
# → 200 {"userSettings":{}}

# 4. List all methods present in the binary
BIN="/opt/Antigravity IDE/resources/app/extensions/antigravity/bin/language_server_linux_x64"
strings -n 6 "$BIN" | grep -E "exa\.language_server_pb\.LanguageServerService/" | sort -u
```
