# Memdex

Local-first cross-project conversation memory index for **Google Antigravity**, built with Node.js built-in `node:sqlite` (zero native compilation) and the Model Context Protocol (MCP).

> Inspired by [Shankarsan-Sahoo/persistent-memory-plugin](https://github.com/Shankarsan-Sahoo/persistent-memory-plugin), re-engineered in Node.js for Antigravity 2.0, macOS/Linux/Windows portability, and Chinese/English full-text search.

## Features

- **Zero native compilation**: Uses Node.js (`>= 22.5`) built-in `node:sqlite` (`DatabaseSync`) with WAL mode. No Python, no `uv`, no `better-sqlite3`.
- **Chinese & English hybrid search**: Indexes messages in SQLite FTS5 with `tokenize='trigram'` for terms of length ≥ 3, with case-insensitive substring fallback for 2-character queries (e.g. `记忆`, `js`).
- **Noise-free indexing**: Indexes only `USER_INPUT` (stripped of internal metadata XML wrappers) and non-empty `PLANNER_RESPONSE`. Excludes `GENERIC` tool outputs.
- **Multi-surface transcript discovery**: Scans `~/.gemini/antigravity/brain`, `~/.gemini/antigravity-ide/brain`, and `~/.gemini/antigravity-cli/brain`.
- **Fast incremental `Stop` hook**: Tracks `(file_mtime, file_size)` per conversation, syncs only the finished session on turn stop, and prints valid `{}` JSON to stdout.
- **On-demand recall via MCP**: Avoids noisy per-step `PreInvocation` auto-injection. Exposes 4 focused MCP tools:
  - `search_past_memory(query, project?, limit?)`
  - `get_conversation_detail(conversation_id, max_messages?)`
  - `list_recent_conversations(limit?, project?)`
  - `sync_memory_now(force?)`

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
# Run automated regression tests (unit + Stop hook + MCP stdio E2E)
npm test

# Incrementally sync all local Antigravity transcripts
npm run sync

# Search indexed conversations from the terminal
node scripts/harness.mjs search "全局记忆"

# List recent indexed conversations
npm run list
```

## License

MIT
