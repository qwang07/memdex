# Manual Dream and verification

Dream stores the review's progress in the existing `dreamed_msg_count` and `dreamed_at` fields. It shares the L2 write and index rebuild path with ordinary notes. The SessionStart gate reminds the user when at least five conversations are pending and the last recorded review was at least 24 hours ago or no review has been recorded. When a workspace is active, the SessionStart reminder highlights the current project's pending session count alongside the global total. A manual review can run independently of that gate.

Dream includes spawned sub-sessions by default. A sub-session is a conversation whose opening prompt or host metadata marks it as started by another session, such as a Claude App project thread (opening with `Background (from the session that started this one)`), a Claude Code or Codex sub-agent, or a task notification. Project threads often hold the actual work, so both the candidate list and the SessionStart reminder count them. Pass `include_subsessions: false` to `get_dream_candidates` to review main human sessions only. `list_recent_conversations` and `memdex list` still hide sub-sessions by default, and search results include them with a `[subsession]` badge.

## Tools

Call both tools through `memdex mcp` over local stdio. Each response contains a JSON object in its text content.

- `get_dream_candidates` takes an optional absolute `workspace` or unique `project` selector (absolute path, full slug, or unique directory name), an optional exact `source`, `limit` from 1 to 20 (default 5), `max_messages` from 1 to 50 (default 20) per candidate, and `include_subsessions` (default `true`; `false` skips sub-sessions). Omit `workspace` and `project` for global conversations. The response returns the canonical `workspace`, `total_pending`, `hidden_subsessions` (pending sub-sessions skipped by `include_subsessions: false`, otherwise `0`), and newest-first `candidates`, each with a contiguous window of unreviewed messages and its receipt.
- `mark_dreamed` takes the same `workspace` or `project` and up to 20 receipts. Submit the returned receipt unchanged. Results are `marked`, `already_marked`, `stale`, or `not_found`. A stale receipt requires a fresh read. A workspace mismatch returns the same result as a missing conversation.

A receipt records the start and end message counts and a hash of the ordered rows in that window. The write validates the receipt in a transaction. Appends beyond the window remain pending. Changes within the reviewed window invalidate a pending receipt. Repeat acknowledgements leave the saved count and timestamp in place. The watermark tracks the count of a reviewed prefix. It does not track later historical edits to a prefix that was already marked.

Write and verify any new notes and their indexes before acknowledging their source windows. A fully reviewed window with no new durable information can still be acknowledged. Leave a window pending if a required note write or verification fails.

## Note review

A note review cleans up existing L2 notes in one scope. It reads no L3 windows and changes no watermark. The [memdex-dream Skill](../skills/memdex-dream/SKILL.md) defines the review procedure.

- `list_memory_notes` takes the same optional absolute `workspace` as the Dream tools. It returns every note in that exact scope, oldest first. A project scope never lists global notes or other projects.
- Each entry carries `id`, `type`, `name`, `description`, `updated`, `age_days`, `stale`, `source_count`, and `in_index`. `stale` is true at 14 days or older. `in_index` is false when the line, byte, or scope budget hides the note from the SessionStart index for that scope.
- The top level carries `total`, `hidden`, and `stale` counts.

The review writes through `upsert_memory` and `delete_memory`. Both rebuild `MEMORY.md`. Re-saving a confirmed note through `upsert_memory` sets `updated` to the current time and resets its age.

For a handled `upsert_memory` publication error, Memdex restores any already replaced Markdown files and rolls back the SQLite note and search index. Fix the underlying write error and retry the same scope and slug. Check the note and `MEMORY.md` after restarting the local MCP server before acknowledging the source window.

A process kill, power loss, concurrent manual edits, or an error during restoration can interrupt file and SQLite consistency. Keep the receipt pending. Compare the Markdown note, the SQLite note, and `MEMORY.md` in a copy first. After choosing the authoritative Markdown, rebuild from it with `memdex sync` in the isolated copy and verify the result there.

## Synthetic acceptance

Run `npm test` in an offline environment with temporary `HOME`, `MEMDEX_HOME`, and explicit fake host roots. Run `node --test tests/dream.test.mjs` for the focused check. The test starts the actual CLI MCP server locally and uses `memdex hook session-start --host plain` for both reminder checks. It simulates reviewer decisions with fixed synthetic material. It verifies one deduplicated new note, its index entry, discarded noise, scoped watermark updates, and the pending message appended during review. No model runs in this test.

## Installed-host and real-data checks

Installed-host checks can use separately generated synthetic sessions in a new workspace, host state directory, and Memdex home. Capture host versions and run local Hook and MCP checks against selected fixture paths. An offline replay or mock transport can validate host wiring and serialization where the host supports it. Record which host and mode produced the fixture, then verify source and project attribution, the SessionStart response, note/index writes, and watermark behavior. A synthetic session that requires an actual model call needs separate authorization for that call and its synthetic inputs.

Milestone #1 task 5 separately asks for one complete manual Dream using real, unreviewed conversations on the machine. Run that check only after approval of the exact scope and local copies. Have the operator select one workspace and the minimum approved conversations and notes needed for the check. Export only the approved conversation and message rows in a read-only SQLite transaction. Import them into a new temporary database with any approved L2 note files. Point Memdex and every host discovery path at the temporary directories. Keep production unchanged. Have a human review candidate windows and prepare note changes through a terminal-only local MCP client with no model or outbound connection. Confirm the write, deduplication, index rebuild, watermark, and reminder transition in the copy. Retain only approved content-free results and remove the copy after review. If the approved data does not meet the reminder gate, record that part as unverified.

## Real-data acceptance record (2026-11-25)

Milestone #1 task 5 was run once against real, unreviewed conversations with the operator's approval. Scope: workspace `points-store`, all 6 pending `claude_archive` conversations (118 messages). The rows were exported in a read-only transaction into a temporary `MEMDEX_HOME`, with `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME` and every `MEMDEX_*_DIRS` pointed at empty temporary paths. Production `~/.memdex` was not written.

- Before: `hook session-start --host plain` returned the reminder for 6 unsynthesized sessions; the scope had no L2 notes.
- Review: 6 windows read in full. Overlapping requirements from 3 conversations were merged into one note; transient material (file renames, PDF rendering fixes, tool-access workarounds, vendor price research) was discarded. 3 project notes written via `upsert_memory`.
- Verification after an MCP restart: `read_memory` and `search_past_memory` (`layer: "notes"`) returned the notes; `MEMORY.md` listed 3 entries (4 lines, 747 bytes).
- Watermark: `mark_dreamed` returned `marked` for all 6 receipts; a repeat returned `already_marked`; `get_dream_candidates` then returned none.
- After: `hook session-start` returned only the project index, without the reminder.
