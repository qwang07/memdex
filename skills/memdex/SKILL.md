---
name: memdex
description: Recall past Antigravity conversations across projects using the memdex MCP server. Use when the user references earlier sessions ("上次", "之前", "以前聊过"), asks to recall past bug fixes, architectural decisions, or wants to search or sync cross-project conversation history. Do NOT invoke on routine self-contained tasks that do not need historical context.
---

# Memdex — Cross-Project Conversation Recall

Use the `memdex` MCP tools for on-demand cross-project recall:

1. **Search first**: Call `search_past_memory(query, project?, limit?)` with 1-3 focused Chinese or English keywords.
2. **Drill down when needed**: If a snippet matches the topic, call `get_conversation_detail(conversation_id)` to read the full Q&A exchange instead of guessing from a fragment.
3. **Browse recent work**: When the user asks what was worked on recently or yesterday, call `list_recent_conversations(limit?, project?)`.
4. **Backfill or refresh**: If older sessions are missing, call `sync_memory_now()`.

Store durable coding standards and personal preferences in global rules (or capture them via `/learn`) rather than relying on raw conversation search.
