---
name: memdex
description: Recall and save Memdex notes across hosts. Use when the user asks about earlier work, decisions, or preferences that could be in Memdex. Also use right away when the user says to remember something ("记住", "remember", "以后都…") or corrects how you work, so the note is saved during the conversation instead of waiting for Dream.
---

# Memdex Recall

1. Use the host's SessionStart index when it is available. For manual recall, call `get_memory_index` with the current workspace to find global and project notes. Read relevant notes with `read_memory`.
2. Call `search_past_memory` with focused keywords and the requested project or source. The default search includes L2 notes and L3 conversations. Use the source and age shown in the results to judge whether a claim needs rechecking.
3. Use `get_conversation_detail` for missing context or `list_recent_conversations` for recent work. Refer to the conversation or note ID when reporting recalled facts. Run `sync_memory_now` when the user requests a refresh of the permitted local sources.

A SessionStart Dream reminder is informational. For a requested manual review, use the [memdex-dream Skill](../memdex-dream/SKILL.md).

# Saving During the Conversation

Save a note with `upsert_memory` in the same turn, before you continue the task, when one of these happens:

- The user explicitly asks you to remember something ("记住…", "remember…", "from now on…", "以后都…").
- The user corrects how you work, such as a wrong assumption, an unwanted habit, or a rule to follow next time. Save it as `feedback`.
- The user states a durable fact about themselves, such as their role, expertise, language, or a lasting preference. Save it as `user`.
- The user confirms a non-obvious approach you should keep using. Save it as `feedback`.

Dream still reviews the conversation later. These writes cover what the user said directly, so it is not lost if Dream never runs.

## What to save

- Choose `scope: "global"` for facts about the user and for rules that apply in every project. Choose `scope: "project"` with the absolute workspace path for rules and facts that only hold in this project. If the user does not say, prefer project scope for anything tied to this codebase.
- Write one subject per note. Give it a short kebab-case `slug`, a clear `name`, and a one-line `description` that says when the note matters.
- Put the rule or fact first in `content`. For `feedback`, follow it with a `**Why:**` line (the reason the user gave, or the incident behind it) and a `**How to apply:**` line.
- Use absolute dates. Convert "today", "next week", and similar to ISO dates.

## What not to save

- Do not save content that only matters to the current task, such as temporary status, a one-off command, or the current step of a plan.
- Do not save facts that the repository already records, such as code structure, git history, or README content.
- Do not save secrets, credentials, tokens, or other sensitive personal data, even when asked. Tell the user why.
- Do not save your own guesses about the user. Save what the user said or confirmed.

## Update instead of duplicating

1. Before you write, check whether an existing note already covers the subject. Use the SessionStart index, or call `search_past_memory` with `layer: "notes"`, and read the candidate with `read_memory`.
2. If a note covers it, call `upsert_memory` with the same `scope`, `workspace`, and `slug`. Merge the old and new content so nothing useful is lost.
3. If the correction contradicts an existing note, rewrite that note with the new rule. Use `delete_memory` for a note that no longer holds.
4. Create a new note only when no existing note fits.

## Index budget

The injected index holds at most 50 global lines, 100 project lines, and 150 lines or 8 KB in total. Notes beyond the budget no longer appear at session start. The `upsert_memory` result reports budget use. When it returns a `[Budget Warning]`, merge related notes before you add more. Rewrite the surviving note with `upsert_memory` and delete the merged notes with `delete_memory`. Tell the user in one line which notes you merged.

After you save, tell the user in one short line what you saved and its note ID. Then continue the task.
