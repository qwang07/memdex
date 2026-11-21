/**
 * Memdex: local-first conversation memory index, incremental transcript syncer,
 * Chinese/English hybrid search engine, and Antigravity Stop hook.
 *
 * Uses Node.js built-in `node:sqlite` (zero external dependencies, zero native compilation).
 * Inspired by Shankarsan-Sahoo/persistent-memory-plugin.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PLUGIN_ROOT = path.resolve(__dirname, "..");
export const DEFAULT_DB_PATH = path.join(PLUGIN_ROOT, "data", "memory.db");
export const HOOK_LOG_PATH = path.join(PLUGIN_ROOT, "data", "hook.log");
export const SCHEMA_VERSION = 2;
export const DEFAULT_WORKSPACE = "Global / No Workspace";

const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
const METADATA_BLOCK_RE =
  /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/g;
const QUERY_SPLIT_RE = /[\s,，。、;；:：?!？！/\\()（）[\]【】"'`<>《》]+/;

const WORKSPACE_PATTERNS = [
  /((?:\/Users|\/home|\/opt|\/var|\/workspace)[^\n\r"'<>|]+?)\s+->\s+/,
  /(?:CWD|Workspace|Active Document):\s*((?:\/Users|\/home|\/opt|\/var|\/workspace)[^\n\r"'<>|(]+)/,
  /([A-Za-z]:\\[^\n\r"'<>|]+?)\s+->\s+/,
  /(?:CWD|Workspace|Active Document):\s*([A-Za-z]:\\[^\n\r"'<>|(]+)/,
];

function expandHome(filePath) {
  if (!filePath) return filePath;
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

export function resolveDbPath() {
  if (process.env.MEMDEX_DB) {
    return path.resolve(expandHome(process.env.MEMDEX_DB));
  }
  return DEFAULT_DB_PATH;
}

export function getBrainDirs() {
  if (process.env.MEMDEX_BRAIN_DIRS) {
    return process.env.MEMDEX_BRAIN_DIRS.split(path.delimiter)
      .map((p) => expandHome(p.trim()))
      .filter((p) => p && fs.existsSync(p) && fs.statSync(p).isDirectory());
  }

  const home = process.env.USERPROFILE || os.homedir();
  const candidates = [
    path.join(home, ".gemini", "antigravity", "brain"),
    path.join(home, ".gemini", "antigravity-ide", "brain"),
    path.join(home, ".gemini", "antigravity-cli", "brain"),
  ];
  return candidates.filter((dir) => {
    try {
      return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

export function initDb(dbPath = null) {
  const resolved = dbPath ? path.resolve(expandHome(dbPath)) : resolveDbPath();
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const db = new DatabaseSync(resolved, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      last_updated TEXT NOT NULL,
      source_path TEXT NOT NULL DEFAULT '',
      file_mtime REAL NOT NULL DEFAULT 0,
      file_size INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      step_index INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv_step
      ON messages (conversation_id, step_index, id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp
      ON messages (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated
      ON conversations (last_updated DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      conversation_id UNINDEXED,
      role UNINDEXED,
      content,
      timestamp UNINDEXED,
      content='messages',
      content_rowid='id',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, conversation_id, role, content, timestamp)
      VALUES (new.id, new.conversation_id, new.role, new.content, new.timestamp);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, conversation_id, role, content, timestamp)
      VALUES ('delete', old.id, old.conversation_id, old.role, old.content, old.timestamp);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, conversation_id, role, content, timestamp)
      VALUES ('delete', old.id, old.conversation_id, old.role, old.content, old.timestamp);
      INSERT INTO messages_fts(rowid, conversation_id, role, content, timestamp)
      VALUES (new.id, new.conversation_id, new.role, new.content, new.timestamp);
    END;

    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
  return db;
}

export function extractUserRequest(rawContent) {
  if (!rawContent) return "";
  const match = USER_REQUEST_RE.exec(rawContent);
  if (match) return match[1].trim();
  return rawContent.replace(METADATA_BLOCK_RE, "").trim();
}

const IGNORED_PATH_SEGMENTS = ["/.gemini/", "/.bun/", "/.npm/", "/.local/", "/.cache/", "/.config/"];
const PLACEHOLDER_PATH_RE = /(?:^|[/\\])path[/\\]to[/\\]workspace(?:$|[/\\])/i;

function isIgnoredWorkspacePath(pathStr) {
  const normalized = pathStr.replace(/\\/g, "/");
  if (PLACEHOLDER_PATH_RE.test(normalized)) return true;
  return IGNORED_PATH_SEGMENTS.some((seg) => normalized.includes(seg) || normalized.endsWith(seg.slice(0, -1)));
}

export function extractWorkspaceFromText(content) {
  if (!content) return null;
  for (const pattern of WORKSPACE_PATTERNS) {
    const match = pattern.exec(content);
    if (!match) continue;
    const candidate = match[1].trim().replace(/[.,;:)]+$/, "");
    if (!candidate || isIgnoredWorkspacePath(candidate)) continue;
    if (path.extname(candidate) && !candidate.endsWith("/")) {
      return path.dirname(candidate);
    }
    return candidate;
  }
  return null;
}

export function parseTranscriptFile(logFile, workspaceHint = null) {
  let workspace = workspaceHint && workspaceHint.trim() ? workspaceHint.trim() : "";
  let lastUpdated = "";
  const messages = [];

  const raw = fs.readFileSync(logFile, "utf8");
  const lines = raw.split(/\r?\n/);

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx].trim();
    if (!line) continue;

    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }

    const stepType = step.type;
    const content = typeof step.content === "string" ? step.content : "";
    const createdAt = typeof step.created_at === "string" ? step.created_at : "";
    const stepIndex = Number.isInteger(step.step_index) ? step.step_index : idx;

    if (createdAt && createdAt > lastUpdated) {
      lastUpdated = createdAt;
    }

    if (stepType === "USER_INPUT") {
      if (!workspace && content) {
        const extracted = extractWorkspaceFromText(content);
        if (extracted) workspace = extracted;
      }
      const clean = extractUserRequest(content);
      if (clean) {
        messages.push({ stepIndex, role: "USER", content: clean, timestamp: createdAt });
      }
    } else if (stepType === "PLANNER_RESPONSE") {
      const clean = content.trim();
      if (clean) {
        messages.push({ stepIndex, role: "AI", content: clean, timestamp: createdAt });
      }
    }
  }

  if (!workspace) {
    workspace = DEFAULT_WORKSPACE;
  }
  if (!lastUpdated) {
    const stat = fs.statSync(logFile);
    lastUpdated = new Date(stat.mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  return { workspace, lastUpdated, messages };
}

export function syncConversation(db, convId, logFile, { workspaceHint = null, force = false } = {}) {
  if (!fs.existsSync(logFile)) return "empty";

  const stat = fs.statSync(logFile);
  const fileMtime = stat.mtimeMs;
  const fileSize = stat.size;

  const existing = db
    .prepare("SELECT workspace, file_mtime, file_size FROM conversations WHERE id = ?")
    .get(convId);

  const hasBetterWorkspace =
    Boolean(workspaceHint) &&
    existing &&
    existing.workspace === DEFAULT_WORKSPACE &&
    workspaceHint !== DEFAULT_WORKSPACE;

  if (
    !force &&
    existing &&
    !hasBetterWorkspace &&
    Math.abs(existing.file_mtime - fileMtime) < 1e-3 &&
    existing.file_size === fileSize
  ) {
    return "skipped";
  }

  let effectiveHint = workspaceHint;
  if (!effectiveHint && existing && existing.workspace !== DEFAULT_WORKSPACE) {
    effectiveHint = existing.workspace;
  }

  const { workspace, lastUpdated, messages } = parseTranscriptFile(logFile, effectiveHint);
  if (messages.length === 0) return "empty";

  const upsertConv = db.prepare(`
    INSERT INTO conversations (id, workspace, last_updated, source_path, file_mtime, file_size, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace = excluded.workspace,
      last_updated = excluded.last_updated,
      source_path = excluded.source_path,
      file_mtime = excluded.file_mtime,
      file_size = excluded.file_size,
      message_count = excluded.message_count
  `);
  const deleteOld = db.prepare("DELETE FROM messages WHERE conversation_id = ?");
  const insertMsg = db.prepare(
    "INSERT INTO messages (conversation_id, step_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)"
  );

  db.exec("BEGIN");
  try {
    upsertConv.run(convId, workspace, lastUpdated, logFile, fileMtime, fileSize, messages.length);
    deleteOld.run(convId);
    for (const msg of messages) {
      insertMsg.run(convId, msg.stepIndex, msg.role, msg.content, msg.timestamp);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return "updated";
}

function findTranscriptInConvDir(convDir) {
  const logsDir = path.join(convDir, ".system_generated", "logs");
  for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
    const candidate = path.join(logsDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function syncAllBrainDirs(db, { force = false } = {}) {
  const brainDirs = getBrainDirs();
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let empty = 0;

  for (const brainDir of brainDirs) {
    let entries;
    try {
      entries = fs.readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convDir = path.join(brainDir, entry.name);
      const logFile = findTranscriptInConvDir(convDir);
      if (!logFile) continue;

      scanned += 1;
      const status = syncConversation(db, entry.name, logFile, { force });
      if (status === "updated") updated += 1;
      else if (status === "skipped") skipped += 1;
      else empty += 1;
    }
  }

  const totalConversations = db.prepare("SELECT COUNT(*) AS cnt FROM conversations").get().cnt;
  const totalMessages = db.prepare("SELECT COUNT(*) AS cnt FROM messages").get().cnt;

  return {
    brainDirs,
    scanned,
    updated,
    skipped,
    empty,
    totalConversations,
    totalMessages,
  };
}

export function tokenizeQuery(query) {
  const rawTokens = (query || "")
    .trim()
    .split(QUERY_SPLIT_RE)
    .map((t) => t.trim())
    .filter(Boolean);

  if (rawTokens.length === 0) return [];

  let filtered = rawTokens.filter((t) => t.length >= 2);
  if (filtered.length === 0) filtered = rawTokens;

  const seen = new Set();
  const terms = [];
  for (const token of filtered) {
    const key = token.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      terms.push(token);
    }
  }
  return terms.slice(0, 12);
}

function quoteFtsTerm(term) {
  return `"${term.replace(/"/g, '""')}"`;
}

export function extractSnippet(content, terms, radius = 500) {
  if (!content) return "";
  const lower = content.toLowerCase();
  let hitIdx = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx !== -1 && (hitIdx === -1 || idx < hitIdx)) {
      hitIdx = idx;
    }
  }

  if (hitIdx === -1) {
    return content.length > radius * 2 ? `${content.slice(0, radius * 2)}\n...` : content;
  }

  const start = Math.max(0, hitIdx - radius);
  const end = Math.min(content.length, hitIdx + radius);
  const prefix = start > 0 ? "...\n" : "";
  const suffix = end < content.length ? "\n..." : "";
  return `${prefix}${content.slice(start, end)}${suffix}`;
}

function runFtsQuery(db, ftsExpr, shortTerms, project, excludeConversationId, excludeIds, limit) {
  const where = ["messages_fts MATCH ?"];
  const params = [ftsExpr];

  for (const term of shortTerms) {
    where.push("instr(lower(m.content), lower(?)) > 0");
    params.push(term);
  }
  if (project) {
    where.push("instr(lower(c.workspace), lower(?)) > 0");
    params.push(project);
  }
  if (excludeConversationId) {
    where.push("m.conversation_id != ?");
    params.push(excludeConversationId);
  }
  if (excludeIds.size > 0) {
    const ids = [...excludeIds];
    where.push(`m.id NOT IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }

  const sql = `
    SELECT m.id, m.conversation_id, m.step_index, c.workspace, m.role, m.content, m.timestamp,
           bm25(messages_fts) AS rank
    FROM messages_fts
    JOIN messages m ON messages_fts.rowid = m.id
    JOIN conversations c ON m.conversation_id = c.id
    WHERE ${where.join(" AND ")}
    ORDER BY rank ASC, m.timestamp DESC
    LIMIT ?
  `;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function runLikeQuery(db, terms, matchAll, project, excludeConversationId, excludeIds, limit) {
  const joiner = matchAll ? " AND " : " OR ";
  const termExpr = terms.map(() => "instr(lower(m.content), lower(?)) > 0").join(joiner);
  const where = [`(${termExpr})`];
  const params = [...terms];

  if (project) {
    where.push("instr(lower(c.workspace), lower(?)) > 0");
    params.push(project);
  }
  if (excludeConversationId) {
    where.push("m.conversation_id != ?");
    params.push(excludeConversationId);
  }
  if (excludeIds.size > 0) {
    const ids = [...excludeIds];
    where.push(`m.id NOT IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }

  const sql = `
    SELECT m.id, m.conversation_id, m.step_index, c.workspace, m.role, m.content, m.timestamp,
           0.0 AS rank
    FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    WHERE ${where.join(" AND ")}
    ORDER BY m.timestamp DESC, m.id DESC
    LIMIT ?
  `;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function searchMessages(db, query, { project = "", limit = 5, excludeConversationId = "" } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 50));
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return [];

  const trigramTerms = terms.filter((t) => t.length >= 3);
  const shortTerms = terms.filter((t) => t.length < 3);

  const rows = [];
  const seenIds = new Set();

  if (trigramTerms.length > 0) {
    const andExpr = trigramTerms.map(quoteFtsTerm).join(" AND ");
    for (const row of runFtsQuery(db, andExpr, shortTerms, project, excludeConversationId, seenIds, safeLimit)) {
      rows.push(row);
      seenIds.add(row.id);
    }

    if (rows.length < safeLimit && (trigramTerms.length > 1 || shortTerms.length > 0)) {
      const orExpr = trigramTerms.map(quoteFtsTerm).join(" OR ");
      const remaining = safeLimit - rows.length;
      for (const row of runFtsQuery(db, orExpr, [], project, excludeConversationId, seenIds, remaining)) {
        rows.push(row);
        seenIds.add(row.id);
      }
    }
  }

  if (rows.length < safeLimit && shortTerms.length > 0) {
    const remaining = safeLimit - rows.length;
    for (const row of runLikeQuery(db, shortTerms, true, project, excludeConversationId, seenIds, remaining)) {
      rows.push(row);
      seenIds.add(row.id);
    }

    if (rows.length < safeLimit && shortTerms.length > 1) {
      const stillRemaining = safeLimit - rows.length;
      for (const row of runLikeQuery(db, shortTerms, false, project, excludeConversationId, seenIds, stillRemaining)) {
        rows.push(row);
        seenIds.add(row.id);
      }
    }
  }

  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    stepIndex: row.step_index,
    workspace: row.workspace,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
    rank: Number(row.rank),
    snippet: extractSnippet(row.content, terms),
  }));
}

export function listConversations(db, { limit = 10, project = "" } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const params = [];
  let where = "";
  if (project) {
    where = "WHERE instr(lower(c.workspace), lower(?)) > 0";
    params.push(project);
  }
  params.push(safeLimit);

  const rows = db
    .prepare(`
      SELECT c.id, c.workspace, c.last_updated, c.message_count,
             (SELECT m.content FROM messages m
              WHERE m.conversation_id = c.id AND m.role = 'USER'
              ORDER BY m.step_index ASC, m.id ASC LIMIT 1) AS first_user_message
      FROM conversations c
      ${where}
      ORDER BY c.last_updated DESC
      LIMIT ?
    `)
    .all(...params);

  return rows.map((row) => {
    let preview = (row.first_user_message || "").replace(/\s+/g, " ").trim();
    if (preview.length > 120) preview = `${preview.slice(0, 120)}...`;
    return {
      conversationId: row.id,
      workspace: row.workspace,
      lastUpdated: row.last_updated,
      messageCount: row.message_count,
      summary: preview,
    };
  });
}

export function getConversationMessages(db, conversationId, { maxMessages = 20 } = {}) {
  const safeMax = Math.max(1, Math.min(Number(maxMessages) || 20, 100));
  const conv = db
    .prepare("SELECT id, workspace, last_updated, message_count FROM conversations WHERE id = ?")
    .get(conversationId);
  if (!conv) return { conversation: null, messages: [] };

  const messages = db
    .prepare(`
      SELECT step_index, role, content, timestamp
      FROM messages
      WHERE conversation_id = ?
      ORDER BY step_index ASC, id ASC
      LIMIT ?
    `)
    .all(conversationId, safeMax);

  return {
    conversation: {
      id: conv.id,
      workspace: conv.workspace,
      lastUpdated: conv.last_updated,
      messageCount: conv.message_count,
    },
    messages: messages.map((m) => ({
      stepIndex: m.step_index,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
  };
}

function logHookError(err) {
  try {
    fs.mkdirSync(path.dirname(HOOK_LOG_PATH), { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(HOOK_LOG_PATH, `[${ts}] ${err?.stack || err}\n`, "utf8");
  } catch {
    // Never fail a hook because of logging.
  }
}

function resolveHookTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  const resolved = expandHome(transcriptPath);
  const fullCandidate = path.join(path.dirname(resolved), "transcript_full.jsonl");
  if (fs.existsSync(fullCandidate)) return fullCandidate;
  if (fs.existsSync(resolved)) return resolved;
  return null;
}

function inferConvId(payload, logFile) {
  if (typeof payload.conversationId === "string" && payload.conversationId.trim()) {
    return payload.conversationId.trim();
  }
  const parts = logFile.split(path.sep);
  const sysIdx = parts.indexOf(".system_generated");
  if (sysIdx > 0) return parts[sysIdx - 1];
  return path.basename(path.dirname(logFile));
}

export function runStopHook() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    const payload = raw ? JSON.parse(raw) : {};
    const logFile = resolveHookTranscript(payload.transcriptPath || "");
    if (logFile) {
      const convId = inferConvId(payload, logFile);
      const workspaceHint =
        Array.isArray(payload.workspacePaths) && payload.workspacePaths.length > 0
          ? payload.workspacePaths[0]
          : null;
      const db = initDb();
      try {
        syncConversation(db, convId, logFile, { workspaceHint });
      } finally {
        db.close();
      }
    }
  } catch (err) {
    logHookError(err);
  }
  process.stdout.write("{}\n");
}

function parseCliArgs(argv) {
  const opts = { hook: false, force: false, project: "", limit: 5, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hook") opts.hook = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--project" && argv[i + 1]) opts.project = argv[++i];
    else if (arg === "--limit" && argv[i + 1]) opts.limit = Number(argv[++i]) || 5;
    else opts.positional.push(arg);
  }
  return opts;
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.hook) {
    runStopHook();
    return;
  }

  const [action, ...rest] = opts.positional;
  if (!action || !["update", "search", "list"].includes(action)) {
    process.stderr.write("Usage: node scripts/harness.mjs [--hook | update [--force] | search <query> | list]\n");
    process.exit(1);
  }

  const db = initDb();
  try {
    if (action === "update") {
      const stats = syncAllBrainDirs(db, { force: opts.force });
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    } else if (action === "search") {
      const query = rest.join(" ").trim();
      if (!query) {
        process.stderr.write("Error: Please provide a search query.\n");
        process.exit(1);
      }
      const results = searchMessages(db, query, { project: opts.project, limit: opts.limit });
      if (results.length === 0) {
        process.stdout.write(`No results found for: ${query}\n`);
        return;
      }
      for (const item of results) {
        process.stdout.write(
          `[${item.timestamp}] ${item.workspace} | ${item.role} (conv=${item.conversationId}, rank=${item.rank.toFixed(2)})\n`
        );
        process.stdout.write(`${item.snippet}\n${"-".repeat(50)}\n`);
      }
    } else if (action === "list") {
      const convs = listConversations(db, { limit: opts.limit, project: opts.project });
      for (const item of convs) {
        process.stdout.write(
          `[${item.lastUpdated}] ${item.conversationId} | ${item.workspace} (${item.messageCount} msgs) — ${item.summary}\n`
        );
      }
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
