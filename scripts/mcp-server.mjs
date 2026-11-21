/**
 * Memdex MCP stdio server exposing local Antigravity conversation memory tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getConversationMessages,
  initDb,
  listConversations,
  searchMessages,
  syncAllBrainDirs,
} from "./harness.mjs";

const server = new McpServer({
  name: "memdex",
  version: "0.1.0",
});

server.tool(
  "search_past_memory",
  "Search past Antigravity conversations across all projects (supports Chinese and English). Use when recalling prior sessions, past bug fixes, architectural decisions, or recurring setup steps.",
  {
    query: z.string().min(1).describe("Keywords or phrase to search for (Chinese or English)."),
    project: z.string().optional().default("").describe("Optional workspace/project path substring filter."),
    limit: z.number().int().min(1).max(50).optional().default(5).describe("Maximum number of matches (default 5)."),
  },
  async ({ query, project, limit }) => {
    const db = initDb();
    let results;
    try {
      results = searchMessages(db, query, { project, limit });
    } finally {
      db.close();
    }

    if (results.length === 0) {
      const scope = project ? ` in project '${project}'` : "";
      return { content: [{ type: "text", text: `No past memory found for '${query}'${scope}.` }] };
    }

    const lines = [`Found ${results.length} memory match(es) for '${query}':\n`];
    results.forEach((item, idx) => {
      lines.push(
        `### Match ${idx + 1}\n` +
          `- Conversation ID: \`${item.conversationId}\`\n` +
          `- Project: \`${item.workspace}\`\n` +
          `- Date: ${item.timestamp}\n` +
          `- Role: ${item.role}\n\n` +
          `${item.snippet}\n` +
          `${"-".repeat(40)}`
      );
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "get_conversation_detail",
  "Retrieve ordered USER and AI messages for a specific past conversation ID returned by search_past_memory or list_recent_conversations.",
  {
    conversation_id: z.string().min(1).describe("Conversation UUID to inspect."),
    max_messages: z.number().int().min(1).max(100).optional().default(20).describe("Max messages to return."),
  },
  async ({ conversation_id, max_messages }) => {
    const db = initDb();
    let result;
    try {
      result = getConversationMessages(db, conversation_id, { maxMessages: max_messages });
    } finally {
      db.close();
    }

    if (!result.conversation) {
      return { content: [{ type: "text", text: `Conversation '${conversation_id}' not found in memdex.` }] };
    }

    const conv = result.conversation;
    const lines = [
      `Conversation \`${conv.id}\` | Project: \`${conv.workspace}\` | Updated: ${conv.lastUpdated} | Total Messages: ${conv.messageCount}\n`,
    ];
    for (const msg of result.messages) {
      const text = msg.content.length > 2000 ? `${msg.content.slice(0, 2000)}\n...[truncated]` : msg.content;
      lines.push(`**[${msg.timestamp}] ${msg.role} (step ${msg.stepIndex}):**\n${text}\n`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "list_recent_conversations",
  "List recently indexed Antigravity conversations with their project and opening prompt.",
  {
    limit: z.number().int().min(1).max(50).optional().default(10).describe("Number of conversations to list."),
    project: z.string().optional().default("").describe("Optional workspace/project path substring filter."),
  },
  async ({ limit, project }) => {
    const db = initDb();
    let convs;
    try {
      convs = listConversations(db, { limit, project });
    } finally {
      db.close();
    }

    if (convs.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No indexed conversations found yet. Call `sync_memory_now` to scan local transcripts.",
          },
        ],
      };
    }

    const lines = [`Recent ${convs.length} conversation(s):\n`];
    for (const item of convs) {
      lines.push(
        `- \`${item.conversationId}\` | ${item.lastUpdated} | \`${item.workspace}\` (${item.messageCount} msgs): ${item.summary}`
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "sync_memory_now",
  "Incrementally scan local Antigravity brain directories and index new or updated transcripts.",
  {
    force: z.boolean().optional().default(false).describe("Force re-index unchanged transcript files."),
  },
  async ({ force }) => {
    const db = initDb();
    let stats;
    try {
      stats = syncAllBrainDirs(db, { force });
    } finally {
      db.close();
    }

    const text =
      `Memdex sync complete.\n` +
      `- Brain dirs: ${stats.brainDirs.join(", ") || "(none found)"}\n` +
      `- Scanned: ${stats.scanned} | Updated: ${stats.updated} | Skipped (unchanged): ${stats.skipped} | Empty: ${stats.empty}\n` +
      `- Database totals: ${stats.totalConversations} conversations, ${stats.totalMessages} messages`;
    return { content: [{ type: "text", text }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
