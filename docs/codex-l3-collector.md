# Codex L3 collector contract

## Input

Read local Codex rollout JSONL from `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`. Default `CODEX_HOME` to `~/.codex` when it is unset. Discover ordinary `rollout-*.jsonl` files beneath these roots. Skip directory symlinks, compressed files and unrelated files.

Set `MEMDEX_CODEX_DIRS` to replace default roots. Separate roots with the platform path delimiter. Set `MEMDEX_CODEX_DIRS` to the empty string to disable Codex discovery. Use this override and `MEMDEX_BRAIN_DIRS` in tests to confine discovery to fixtures.

Require a valid UUID in the first usable `session_meta.payload.id`. Use the thread ID from `id` even when `session_id` differs. Store the conversation as `codex:<uuid>` with `source = codex`. Preserve existing Antigravity IDs.

## Conversation records

Use `response_item` records whose payload type is `message`. Read text from user `input_text` blocks and assistant `output_text` blocks. Join the accepted blocks in each message in their original order.

Use the Codex content-kind metadata when present on a user block. Keep `user.text` blocks. For older blocks without content-kind metadata, exclude generated instruction and environment blocks such as `# AGENTS.md instructions`, `<user_instructions>` and `<environment_context>`. Skip empty messages.

Keep assistant messages with `phase = final_answer`. Treat an absent or null phase as a legacy assistant message. Skip commentary, reasoning, tool data, developer and system messages. Skip all `event_msg` records because they can mirror conversation messages. Ignore malformed JSON lines and accept the valid prefix of a file with an incomplete trailing line. Preserve repeated human text when it represents separate messages.

Use the first valid absolute `session_meta.payload.cwd` as the workspace. Fall back to the first valid absolute `turn_context.payload.cwd`. Use the existing global workspace value if neither field is usable. Pass the workspace through the existing normalization and slug logic. Use JSONL line order for the message sequence and the newest indexed message timestamp for conversation freshness. Normalize valid timestamps to ISO UTC. Use the rollout file modification time when valid message timestamps are unavailable.

## Sync

Route the unified CLI `memdex sync` and MCP `sync_memory_now` through a shared sync path. Keep the existing Antigravity discovery, Stop Hook and legacy harness entry working. Include both sources in the existing aggregate CLI counters and preserve the `brainDirs` field for Antigravity. Keep the existing source and project filters for `search` and `list`.

Index one readable rollout per Codex thread per sync. Prefer the newest modification time among copies. Break ties by preferring the larger file and then by a stable path order. Skip an unchanged selected rollout by matching the stored source path, size and modification time. Reindex a changed rollout and `--force` through the existing transactional upsert. Preserve conversation identity and the Dream watermark. Skip a single unreadable or invalid rollout and continue scanning the other files.

## Acceptance

Run `npm test`. Run `node tests/acceptance/codex-l3.mjs` against the candidate checkout. The second command uses synthetic files and an isolated database. It checks active and archived discovery, project attribution, source ID collisions, plain-text selection, repeat sync, append updates and force sync.

Check the parser against a separately generated local Codex CLI 0.170.0 rollout before accepting the candidate. Keep that rollout local. It contains account and host fields outside the collector input contract. Copy only independently authored synthetic data into the repository.

Defer Claude Code, Gemini CLI, Retinue, compressed rollouts and native Codex state database support.
