# Connect hosts to Memdex

Run `memdex sync` to update conversation search for Antigravity, Codex, Claude Code, and Gemini CLI. Run `memdex mcp` to make recall and manual sync available over stdio. Use `memdex search "<query>" --source <source> --project <selector>` to check attribution. Pass an absolute workspace path, a complete project slug, or an exact directory name that identifies one workspace. Missing and ambiguous selectors return no matches. Hook-enabled hosts can use `memdex hook session-start --host <host>` to load a scoped memory index.

| Host | L3 input | SessionStart or recall |
| --- | --- | --- |
| Antigravity | Reads the configured brain directories. The existing `antigravity` Stop Hook imports the finished session. | Use the packaged `antigravity` SessionStart Hook and MCP configuration. |
| Codex | Reads `sessions` and `archived_sessions` within `CODEX_HOME`. See the [Codex collector contract](codex-l3-collector.md). | Point a stdio MCP server at `memdex mcp`. Call `get_memory_index` with the current workspace for scoped recall. |
| Claude Code | Reads top-level session JSONL under each project in `CLAUDE_CONFIG_DIR/projects`. The default config directory is `~/.claude`. Use source `claude-code`. | Register `memdex hook session-start --host claude` as a command hook. Point a stdio MCP server at `memdex mcp`. |
| Gemini CLI | Reads `session-*.jsonl` and legacy `session-*.json` in `~/.gemini/tmp/<project>/chats`. `GEMINI_CLI_HOME` replaces the home directory. Use source `gemini-cli`. | Register `memdex hook session-start --host gemini` as a command hook. Point a stdio MCP server at `memdex mcp`. |
| Retinue | Send one conversation snapshot to `memdex ingest --source retinue` on stdin. Use source `retinue`. | Send `{"workspace":"/absolute/project"}` to `memdex hook session-start --host plain` and read `additionalContext`. Alternatively call `get_memory_index` with the workspace through `memdex mcp`. |

The Claude Code adapter uses the session filename for identity and the transcript's absolute `cwd` for workspace attribution. It follows the main parent chain where the transcript carries parent links. It skips nested subagent logs, metadata, and tool blocks. The format evidence is Anthropic's [session storage docs](https://code.claude.com/docs/en/agent-sdk/sessions) and [Agent SDK transcript reader](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/sessions.py).

The Gemini CLI adapter uses `sessionId` for identity and the project directory's `.project_root` marker for workspace attribution. Sessions without a usable marker are global. It reads top-level chat records and applies rewinds and message patches before extracting user and assistant text. The format evidence is Gemini's [session docs](https://geminicli.com/docs/cli/session-management/), [recording source](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts), and [project registry](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/projectRegistry.ts).

## Retinue snapshot

Use an ID stable for the life of the conversation. Include the entire visible conversation in message order. Use `user` and `assistant` roles and ISO-8601 timestamps. Omit `workspace` for global scope, or send an absolute path for project scope.

```json
{
  "id": "session-47",
  "workspace": "/example/ledger",
  "messages": [
    { "role": "user", "content": "Which window did we choose?", "timestamp": "2025-10-07T10:00:00Z" },
    { "role": "assistant", "content": "Seven minutes.", "timestamp": "2025-10-07T10:01:00Z" }
  ]
}
```

```sh
memdex ingest --source retinue < snapshot.json
```

The result includes the namespaced ID, source, and status. Identical snapshots and snapshots whose newest timestamp is older than the stored snapshot return `skipped`. A changed snapshot with the same or newer timestamp replaces the existing messages atomically. The transaction keeps existing Dream watermarks.

For callers that use the package directly, call the same ingestion path from Node ESM.

```js
import { ingestConversation } from "memdex";

const result = ingestConversation(snapshot, { dbPath: "/example/memory.db" });
```

Omit `dbPath` to use the configured Memdex database. The package also exports `initDb`, `syncLocalConversations`, `listConversations`, and `searchMessages`. Close the database handle returned by `initDb` when finished.

## Fixture validation

Create a temporary `HOME` and `MEMDEX_HOME`. Point `MEMDEX_BRAIN_DIRS`, `MEMDEX_CODEX_DIRS`, `MEMDEX_CLAUDE_DIRS`, and `MEMDEX_GEMINI_DIRS` at the synthetic roots. Separate multiple roots with the platform path delimiter. An empty Codex, Claude Code, or Gemini CLI override disables discovery for that source. Set the Antigravity override to an existing empty directory to leave it out of a test.

Run `npm test` and `node tests/acceptance/codex-l3.mjs` inside that environment. These checks cover synthetic host formats and Retinue's Memdex-facing contract. Compatibility with installed hosts and a live Retinue integration requires separate verification.
