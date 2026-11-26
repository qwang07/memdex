# Memdex

Local-first cross-project conversation memory index for **Antigravity, Codex, Claude Code, Gemini CLI, and Retinue**, built with Node.js built-in `node:sqlite` (zero native compilation) and the Model Context Protocol (MCP).

> Inspired by [Shankarsan-Sahoo/persistent-memory-plugin](https://github.com/Shankarsan-Sahoo/persistent-memory-plugin), re-engineered in Node.js for Antigravity 2.0, macOS/Linux/Windows portability, and Chinese/English full-text search.

## Features

- **Zero native compilation**: Uses Node.js (`>= 22.5`) built-in `node:sqlite` (`DatabaseSync`) with WAL mode. No Python, no `uv`, no `better-sqlite3`.
- **Chinese & English hybrid search**: Indexes messages in SQLite FTS5 with `tokenize='trigram'` for terms of length ≥ 3, with case-insensitive substring fallback for 2-character queries (e.g. `记忆`, `js`).
- **Conversation indexing**. Keeps user and assistant text from supported local transcripts and Retinue snapshots.
- **L3 privacy filters**. Memdex redacts secrets before any message reaches SQLite: private keys, JWTs, common API tokens (OpenAI/Anthropic `sk-`, GitHub, AWS, Google, Slack, Stripe, npm), `Bearer` tokens, URL passwords, `password=`/`密码：` values that mix letters and digits, checksum-valid Chinese ID numbers, and Luhn-valid card numbers. Each match becomes `[REDACTED:<kind>]`. Start any of your messages with `#memdex-private` to keep that whole conversation out of L3; Memdex deletes what it already stored and skips the conversation on every later sync. Upgrading to schema v5 applies both rules once to existing conversations.
- **Transcript discovery**. Scans `~/.gemini/antigravity/brain`, `~/.gemini/antigravity-ide/brain`, and `~/.gemini/antigravity-cli/brain`. For Codex, scans `sessions` and `archived_sessions` inside `CODEX_HOME` (defaults to `~/.codex`). See the [host setup guide](docs/host-integration.md) for Claude Code, Gemini CLI, and Retinue.
- **Fast incremental `Stop` hook**: Tracks `(file_mtime, file_size)` per conversation, syncs only the finished Antigravity, Claude Code, or Codex session on turn stop, and prints valid `{}` JSON to stdout.
- **Progressive `SessionStart` hook**: Loads only scoped L2 `MEMORY.md` indexes (global ≤50 lines + current project ≤100 lines; combined incl. reminder ≤150 lines / 8192 UTF-8 bytes; never reads L2 note bodies; silent `{}` on empty store) with an optional 1-line dual-threshold consolidation reminder (≥5 unsynthesized sessions, sub-sessions included, and ≥24h since last `dreamed_at`).
- **Unified `memdex` CLI**: Single Node ESM entrypoint (`bin/memdex.mjs`) serving MCP stdio, local sync, search/list, and thin host Hook adapters (`antigravity`, `claude`, `codex`, `gemini`, `plain`).
- **On-demand recall via MCP**. Read L2 notes and search L3 conversations through the local stdio server.
- **Manual Dream**. Review unprocessed L3 message windows, distill useful findings into L2 notes, and acknowledge the reviewed windows. A note review lists every note in one scope and merges, refreshes, or deletes stale, duplicate, and contradictory notes. See [manual Dream and verification](docs/dream.md).

## Prerequisites

- **Node.js `>= 22.5.0`** (with built-in `node:sqlite` and SQLite FTS5 `trigram` support)

## Installation

1. Clone the repository and install dependencies:

```bash
git clone https://github.com/qwang07/memdex.git
cd memdex
npm install
```

2. Link or copy the directory into Antigravity's global plugins folder:

```bash
ln -s "$(pwd)" ~/.gemini/config/plugins/memdex
```

Antigravity automatically discovers and enables plugins placed under `~/.gemini/config/plugins/`. No `plugins.json` configuration is needed.

3. Backfill existing conversations (optional — new conversations sync automatically via the `Stop` hook):

```bash
npm run sync
```

## CLI Usage & Testing

```bash
# Run automated regression tests (unit + SessionStart/Stop hooks + MCP stdio E2E)
npm test

# Start the MCP stdio server (stdout reserved strictly for MCP protocol)
node bin/memdex.mjs mcp

# Sync local transcripts (L3) and disk notes (L2)
npm run sync
# or: node bin/memdex.mjs sync [--force]

# Import one Retinue conversation snapshot
node bin/memdex.mjs ingest --source retinue < snapshot.json

# Search distilled L2 notes and indexed L3 conversations from the terminal
node bin/memdex.mjs search "全局记忆"

# List recent indexed conversations
npm run list
# or: node bin/memdex.mjs list

# Thin Hook adapters (always emit valid JSON to stdout and fail quietly)
node bin/memdex.mjs hook session-start --host antigravity
node bin/memdex.mjs hook stop --host antigravity
```

Legacy compatibility entrypoints (`node scripts/harness.mjs --hook | update | search | list` and `node scripts/mcp-server.mjs`) remain supported.

### Hook Protocols & Support Boundaries

`memdex hook session-start --host <host>` reads JSON from `stdin` and outputs host-native JSON to `stdout` (or `{}` when the store is empty or on any error):

| `--host` | Workspace `stdin` field | Non-empty `stdout` JSON |
| --- | --- | --- |
| `antigravity` (default) | `workspacePaths[0]` | `{"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}` |
| `claude` | `cwd` | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}` |
| `codex` | `cwd` | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}` |
| `gemini` | `cwd` | `{"hookSpecificOutput":{"additionalContext":"..."}}` |
| `plain` | `workspace` \| `cwd` \| `workspacePaths[0]` | `{"additionalContext":"..."}` |

- **Scope & budget**: Workspaces normalize via `realpath` + deterministic slug. With a workspace, loads `global/MEMORY.md` (≤50 lines) + `projects/<slug>/MEMORY.md` (≤100 lines); without a workspace, loads `global/MEMORY.md` only. Combined injected text (including any 1-line consolidation reminder) is capped at ≤150 lines and ≤8192 UTF-8 bytes. L2 note bodies are never read during `SessionStart`.
- **Dual-threshold reminder**: Appends a single-line reminder when unsynthesized sessions, including spawned sub-sessions such as Claude App project threads (`dreamed_at` empty or `message_count > dreamed_msg_count`) ≥ 5 AND either no prior `dreamed_at` exists or ≥ 24h have elapsed since the most recent `dreamed_at`. Read-only; does not run consolidation, background tasks, or persist state.
- **Experimental SQLite**. Node 22.5–22.11 and Node 23.0–23.1 still load L2 indexes when SQLite is enabled. The startup reminder requires read-only SQLite connections.
- **Stop hook scope**: `memdex hook stop --host antigravity|claude|codex` (default `antigravity`) performs incremental syncing for the reported finished session and outputs `{}`; `gemini` and `plain` are quiet no-ops. Use `memdex sync` to backfill or collect sessions across hosts, and `memdex ingest --source retinue` to ingest Retinue snapshots.
- **Isolated testing**. Set `MEMDEX_HOME` to a temporary directory. Set the [host directory overrides](docs/host-integration.md#fixture-validation) to synthetic roots before running tests.

## License

MIT
