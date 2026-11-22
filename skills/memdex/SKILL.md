---
name: memdex
description: Recall distilled notes and indexed conversations across Memdex hosts. Use when the user asks about earlier work, decisions, or preferences that could be in Memdex.
---

# Memdex Recall

1. Use the host's SessionStart index when it is available. For manual recall, call `get_memory_index` with the current workspace to find global and project notes. Read relevant notes with `read_memory`.
2. Call `search_past_memory` with focused keywords and the requested project or source. The default search includes L2 notes and L3 conversations. Use the source and age shown in the results to judge whether a claim needs rechecking.
3. Use `get_conversation_detail` for missing context or `list_recent_conversations` for recent work. Refer to the conversation or note ID when reporting recalled facts. Run `sync_memory_now` when the user requests a refresh of the permitted local sources.

A SessionStart Dream reminder is informational. For a requested manual review, use the [memdex-dream Skill](../memdex-dream/SKILL.md).
