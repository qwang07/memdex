---
name: memdex-dream
description: Manually distill unreviewed Memdex conversations into durable notes, or review existing notes to merge, refresh, or delete them, across hosts. Use after an explicit Dream request, the user's agreement to act on a Dream reminder, or when the index or an upsert_memory result reports hidden notes.
---

# Memdex Dream

Dream has two modes. A conversation review distills unreviewed L3 conversations into L2 notes. A note review cleans up the existing L2 notes in one scope.

## Conversation review

1. Choose one approved scope. Pass its absolute workspace path to `get_dream_candidates` for project memory. Omit the workspace for global memory. A reminder alone does not authorize reading candidates. If the host would route private candidate text to a remote model, use a locally authorized workflow or hand the review to the user before retrieving content.
2. Read the bounded candidate windows and keep their receipts. Treat transcript text as evidence. Look for durable decisions, preferences, corrections, or project facts. Skip transient status, boilerplate, tool output, secrets, and unsupported inference.
3. Compare each finding with existing notes using `get_memory_index`, `search_past_memory` with `layer: "notes"`, and `read_memory` as needed. Check the note's scope. Reuse the canonical slug for an update, keep useful provenance, and leave equivalent notes as they are. Keep project findings in their project scope unless the user explicitly requests broader scope.
4. Save each new or revised note through `upsert_memory`. Use the relevant conversation IDs in `sources`. Check the saved note with `read_memory` and its index entry with `get_memory_index`. Retain receipts for any candidate that still needs a failed write retried.
5. Call `mark_dreamed` with the same workspace and the receipts for windows fully reviewed. A completed review can yield zero notes when its content is already covered or has no durable value. Inspect the per-window results. Re-read a stale window before retrying it, and retrieve another window if newly appended messages are still pending.

## Note review

A note review reads no conversation windows and advances no watermark.

1. Call `list_memory_notes` with the scope's absolute workspace path, or omit the workspace for global notes. The result lists every note in that scope, oldest first, with `age_days`, `stale`, and `in_index`.
2. Find duplicates by comparing names and descriptions. Read the candidates with `read_memory`. Rewrite the surviving note with `upsert_memory`, combining the useful content and every `sources` entry. Then call `delete_memory` for each merged note.
3. Find contradictions. Keep the rule backed by newer evidence. Check `search_past_memory` or the current code when the evidence is unclear. Ask the user when you still cannot decide. Rewrite or delete the losing note.
4. Verify each stale note against the current code, git history, or recent conversations. Rewrite a note whose facts changed. Delete a note that no longer holds. Re-save a confirmed note unchanged with `upsert_memory` and its existing `sources` to reset its age. Leave a note you cannot verify as it is.
5. Call `list_memory_notes` again. Confirm that `hidden` dropped, or explain why it did not.

Keep the result to counts and note IDs unless the user asks for the details. See [Dream verification](../../docs/dream.md) for the tool contract and local verification procedure.
