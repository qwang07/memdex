/**
 * Memdex MCP stdio server exposing local cross-tool L2 distilled memory & L3 conversation memory tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  deleteMemory,
  getConversationMessages,
  getMemoryIndex,
  initDb,
  listConversations,
  NOTE_SCOPES,
  NOTE_TYPES,
  readMemory,
  resolveDbPath,
  resolveNotesDir,
  searchHybrid,
  syncLocalConversations,
  syncNotesFromDisk,
  upsertMemory,
} from "../scripts/harness.mjs";

export function createMcpServer() {
  const server = new McpServer({
    name: "memdex",
    version: "0.2.0",
  });

  server.tool(
    "get_memory_index",
    "Retrieve the scoped L2 MEMORY.md index (global <=50 lines + optional current project <=100 lines, capped at <=150 lines / 8KB). Use at session start in hosts without SessionStart hooks or to check what distilled notes exist.",
    {
      workspace: z
        .string()
        .optional()
        .default("")
        .describe("Optional absolute path of the current project workspace. Omit for global-only index."),
    },
    async ({ workspace }) => {
      const result = getMemoryIndex({ workspace });
      if (result.empty) {
        return {
          content: [
            {
              type: "text",
              text: "No distilled L2 memory notes indexed for this scope yet.",
            },
          ],
        };
      }

      const meta = [
        `Scope: global (${result.globalCount})` +
          (result.workspaceSlug !== "global" ? ` + project \`${result.workspaceSlug}\` (${result.projectCount})` : ""),
        `Budget: ${result.lines} lines / ${result.bytes} bytes` + (result.truncated ? " [truncated]" : ""),
      ].join(" | ");

      return {
        content: [{ type: "text", text: `${result.text}\n\n---\n${meta}` }],
      };
    }
  );

  server.tool(
    "read_memory",
    "Read the full content of a distilled L2 memory note by canonical ID (e.g. `global/<slug>` or `projects/<workspace-slug>/<slug>`), including provenance sources and staleness warnings.",
    {
      id: z
        .string()
        .min(1)
        .describe("Canonical note ID returned by get_memory_index or search_past_memory."),
    },
    async ({ id }) => {
      const db = initDb();
      let note;
      try {
        note = readMemory(db, id);
      } finally {
        db.close();
      }

      if (!note) {
        return { content: [{ type: "text", text: `Memory note '${id}' not found.` }] };
      }

      const staleBanner = note.stalenessNote ? `\n> [Stale Warning] ${note.stalenessNote}\n` : "";
      const sourcesLine =
        note.sources.length > 0 ? `- Sources: ${note.sources.map((s) => `\`${s}\``).join(", ")}\n` : "";
      const projectLine =
        note.scope === "project" ? `- Project: \`${note.workspace}\` (\`${note.workspaceSlug}\`)\n` : "";

      const text =
        `# ${note.name}\n` +
        `- ID: \`${note.id}\`\n` +
        `- Type: \`${note.type}\` | Scope: \`${note.scope}\`\n` +
        `${projectLine}` +
        `- Updated: ${note.updated} (${note.ageLabel})\n` +
        `${sourcesLine}` +
        `- Description: ${note.description}\n` +
        `${staleBanner}\n` +
        `${note.content}`;

      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "upsert_memory",
    "Create or update a distilled L2 Markdown memory note (global or project-scoped), sync SQLite FTS5 notes_fts, and automatically rebuild the scope's MEMORY.md index.",
    {
      scope: z.enum(NOTE_SCOPES).describe("Memory scope: 'global' or 'project'."),
      type: z.enum(NOTE_TYPES).describe("Memory category: 'user', 'feedback', 'project', or 'reference'."),
      slug: z.string().min(1).describe("Short stable identifier slug for the note filename (e.g. 'v2-architecture')."),
      name: z.string().min(1).describe("Concise human-readable title of the memory note."),
      description: z.string().min(1).describe("One-line summary shown in MEMORY.md index."),
      content: z.string().min(1).describe("Full Markdown body of the distilled memory note."),
      workspace: z
        .string()
        .optional()
        .default("")
        .describe("Absolute project workspace path (required when scope='project')."),
      sources: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Optional list of source conversation IDs supporting this note."),
      updated: z
        .string()
        .optional()
        .default("")
        .describe("Optional ISO-8601 timestamp override (defaults to current UTC time)."),
    },
    async ({ scope, type, slug, name, description, content, workspace, sources, updated }) => {
      const db = initDb();
      let result;
      try {
        result = upsertMemory(db, {
          scope,
          type,
          slug,
          name,
          description,
          content,
          workspace,
          sources,
          updated,
        });
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to upsert memory note: ${err.message}` }],
        };
      } finally {
        db.close();
      }

      const { note, index } = result;
      const text =
        `Saved L2 memory note \`${note.id}\`.\n` +
        `- Type: \`${note.type}\` | Scope: \`${note.scope}\`` +
        (note.scope === "project" ? ` (\`${note.workspace}\`)` : "") +
        `\n- File: ${note.filePath}\n` +
        `- Index rebuilt: ${index.indexPath} (${index.lineCount} lines, ${index.includedNotes}/${index.totalNotes} notes` +
        `${index.truncated ? ", truncated to line budget" : ""})`;
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "delete_memory",
    "Delete an obsolete or contradicted L2 memory note from disk and SQLite, and rebuild its scope's MEMORY.md index.",
    {
      id: z.string().min(1).describe("Canonical note ID to delete (e.g. `global/<slug>` or `projects/<wsSlug>/<slug>`)."),
    },
    async ({ id }) => {
      const db = initDb();
      let result;
      try {
        result = deleteMemory(db, id);
      } finally {
        db.close();
      }

      if (!result.deleted) {
        return { content: [{ type: "text", text: `Memory note '${id}' not found (nothing deleted).` }] };
      }

      const idxInfo =
        result.index && result.index.totalNotes > 0
          ? `Index rebuilt: ${result.index.indexPath} (${result.index.lineCount} lines, ${result.index.totalNotes} note(s)).`
          : "Scope is now empty; MEMORY.md removed.";
      return { content: [{ type: "text", text: `Deleted L2 memory note \`${result.id}\`.\n${idxInfo}` }] };
    }
  );

  server.tool(
    "search_past_memory",
    "L2-first hybrid search across distilled memory notes (L2) and past conversations across projects and hosts (L3). Supports Chinese and English.",
    {
      query: z.string().min(1).describe("Keywords or phrase to search for (Chinese or English)."),
      project: z.string().optional().default("").describe("Optional workspace path or project slug substring filter."),
      source: z
        .string()
        .optional()
        .default("")
        .describe("Optional host source filter for L3 conversations (e.g. antigravity, codex, claude-code, gemini, retinue)."),
      layer: z
        .enum(["all", "notes", "conversations"])
        .optional()
        .default("all")
        .describe("Memory layer to search: 'all' (L2 first then L3, default), 'notes' (L2 only), or 'conversations' (L3 only)."),
      exclude_conversation_id: z
        .string()
        .optional()
        .default("")
        .describe("Optional current conversation ID to exclude from L3 search results."),
      limit: z.number().int().min(1).max(50).optional().default(5).describe("Maximum matches per layer (default 5)."),
    },
    async ({ query, project, source, layer, exclude_conversation_id, limit }) => {
      const db = initDb();
      let hybrid;
      try {
        hybrid = searchHybrid(db, query, {
          project,
          source,
          layer,
          excludeConversationId: exclude_conversation_id,
          limit,
        });
      } finally {
        db.close();
      }

      const { notes, messages } = hybrid;
      if (notes.length === 0 && messages.length === 0) {
        const filters = [
          project ? `project '${project}'` : "",
          source ? `source '${source}'` : "",
        ].filter(Boolean);
        const scope = filters.length > 0 ? ` in ${filters.join(", ")}` : "";
        return { content: [{ type: "text", text: `No past memory found for '${query}'${scope}.` }] };
      }

      const lines = [
        `Found ${notes.length} distilled note(s) (L2) and ${messages.length} conversation match(es) (L3) for '${query}':\n`,
      ];

      if (notes.length > 0) {
        lines.push("## Distilled Notes (L2)\n");
        notes.forEach((note, idx) => {
          const freshnessLine = note.stalenessNote
            ? `- Updated: ${note.updated} (${note.ageLabel}) — [Stale Warning] ${note.stalenessNote}`
            : `- Updated: ${note.updated} (${note.ageLabel})`;
          lines.push(
            `### Note ${idx + 1}: ${note.name}\n` +
              `- ID: \`${note.id}\`\n` +
              `- Type: \`${note.type}\` | Scope: \`${note.scope}\`\n` +
              (note.scope === "project" ? `- Project: \`${note.workspace}\` (\`${note.workspaceSlug}\`)\n` : "") +
              `${freshnessLine}\n` +
              `- Description: ${note.description}\n\n` +
              `${note.snippet}\n` +
              `${"-".repeat(40)}`
          );
        });
      }

      if (messages.length > 0) {
        lines.push("## Conversation Matches (L3)\n");
        messages.forEach((item, idx) => {
          const freshnessLine = item.stalenessNote
            ? `- Date: ${item.timestamp} (${item.ageLabel}) — [Stale Warning] ${item.stalenessNote}`
            : `- Date: ${item.timestamp} (${item.ageLabel})`;
          lines.push(
            `### Match ${idx + 1}\n` +
              `- Conversation ID: \`${item.conversationId}\`\n` +
              `- Source: \`${item.source}\`\n` +
              `- Project: \`${item.workspace}\` (\`${item.workspaceSlug}\`)\n` +
              `${freshnessLine}\n` +
              `- Role: ${item.role}\n\n` +
              `${item.snippet}\n` +
              `${"-".repeat(40)}`
          );
        });
      }

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
      const staleBanner = conv.stalenessNote ? `\n> [Stale Warning] ${conv.stalenessNote}\n` : "";
      const lines = [
        `Conversation \`${conv.id}\` | Source: \`${conv.source}\` | Project: \`${conv.workspace}\` (\`${conv.workspaceSlug}\`) | Updated: ${conv.lastUpdated} (${conv.ageLabel}) | Total Messages: ${conv.messageCount}${staleBanner}\n`,
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
    "List recently indexed conversations across hosts with their source, project, age, and opening prompt.",
    {
      limit: z.number().int().min(1).max(50).optional().default(10).describe("Number of conversations to list."),
      project: z.string().optional().default("").describe("Optional workspace path or project slug substring filter."),
      source: z.string().optional().default("").describe("Optional host source filter."),
    },
    async ({ limit, project, source }) => {
      const db = initDb();
      let convs;
      try {
        convs = listConversations(db, { limit, project, source });
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
          `- \`${item.conversationId}\` | [${item.source}] ${item.lastUpdated} (${item.ageLabel}) | \`${item.workspace}\` (${item.messageCount} msgs): ${item.summary}`
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "sync_memory_now",
    "Incrementally scan local Antigravity and Codex transcripts (L3) and sync hand-edited L2 Markdown notes into SQLite.",
    {
      force: z.boolean().optional().default(false).describe("Force re-index unchanged transcript files."),
    },
    async ({ force }) => {
      const db = initDb();
      let stats;
      let noteStats;
      try {
        stats = syncLocalConversations(db, { force });
        noteStats = syncNotesFromDisk(db);
      } finally {
        db.close();
      }

      const text =
        `Memdex sync complete.\n` +
        `- Database: ${resolveDbPath()}\n` +
        `- Notes dir: ${resolveNotesDir()}\n` +
        `- Brain dirs: ${stats.brainDirs.join(", ") || "(none found)"}\n` +
        `- L3 Conversations — Scanned: ${stats.scanned} | Updated: ${stats.updated} | Skipped: ${stats.skipped} | Empty: ${stats.empty}\n` +
        `- L2 Notes synced from disk — Scanned: ${noteStats.scanned} | Synced: ${noteStats.synced} | Removed: ${noteStats.removed}\n` +
        `- Database totals: ${stats.totalConversations} conversations, ${stats.totalMessages} messages`;
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

export async function startMcpServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
