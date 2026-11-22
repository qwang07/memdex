/**
 * Memdex: local-first cross-tool conversation memory index, incremental transcript syncer,
 * Chinese/English hybrid search engine, and Antigravity Stop hook.
 *
 * Uses Node.js built-in `node:sqlite` (zero external dependencies, zero native compilation).
 * Inspired by Shankarsan-Sahoo/persistent-memory-plugin.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  computeStaleness,
  DEFAULT_SOURCE,
  initDb,
  SCHEMA_VERSION,
  STALE_STRONG_WARNING_DAYS,
  STALE_WARNING_DAYS,
} from "../src/db.mjs";
import {
  buildNoteId,
  deleteMemory,
  getIndexFilePath,
  getMemoryIndex,
  getNoteFilePath,
  getScopeDir,
  GLOBAL_INDEX_MAX_LINES,
  listNotes,
  NOTE_SCOPES,
  NOTE_TYPES,
  parseNoteId,
  parseNoteMarkdown,
  PROJECT_INDEX_MAX_LINES,
  readMemory,
  rebuildScopeIndex,
  renderScopeIndex,
  sanitizeNoteSlug,
  searchNotes,
  serializeNoteMarkdown,
  syncNotesFromDisk,
  TOTAL_INDEX_MAX_BYTES,
  TOTAL_INDEX_MAX_LINES,
  upsertMemory,
} from "../src/notes.mjs";
import {
  DEFAULT_WORKSPACE,
  expandHome,
  GLOBAL_SLUG,
  LEGACY_DB_PATH,
  migrateLegacyDbIfNeeded,
  normalizeWorkspace,
  PLUGIN_ROOT,
  resolveDbPath,
  resolveHookLogPath,
  resolveMemdexHome,
  resolveNotesDir,
  workspaceToSlug,
} from "../src/paths.mjs";

const __filename = fileURLToPath(import.meta.url);

export {
  buildNoteId,
  computeStaleness,
  DEFAULT_SOURCE,
  DEFAULT_WORKSPACE,
  deleteMemory,
  expandHome,
  getIndexFilePath,
  getMemoryIndex,
  getNoteFilePath,
  getScopeDir,
  GLOBAL_INDEX_MAX_LINES,
  GLOBAL_SLUG,
  initDb,
  LEGACY_DB_PATH,
  listNotes,
  migrateLegacyDbIfNeeded,
  normalizeWorkspace,
  NOTE_SCOPES,
  NOTE_TYPES,
  parseNoteId,
  parseNoteMarkdown,
  PLUGIN_ROOT,
  PROJECT_INDEX_MAX_LINES,
  readMemory,
  rebuildScopeIndex,
  renderScopeIndex,
  resolveDbPath,
  resolveHookLogPath,
  resolveMemdexHome,
  resolveNotesDir,
  sanitizeNoteSlug,
  SCHEMA_VERSION,
  searchNotes,
  serializeNoteMarkdown,
  STALE_STRONG_WARNING_DAYS,
  STALE_WARNING_DAYS,
  syncNotesFromDisk,
  TOTAL_INDEX_MAX_BYTES,
  TOTAL_INDEX_MAX_LINES,
  upsertMemory,
  workspaceToSlug,
};

export const DEFAULT_DB_PATH = path.join(os.homedir(), ".memdex", "memory.db");
export const HOOK_LOG_PATH = path.join(os.homedir(), ".memdex", "hook.log");

const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
const METADATA_BLOCK_RE =
  /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/g;
const QUERY_SPLIT_RE = /[\s,，。、;；:：?!？！/\\()（）[\]【】"'`<>《》]+/;

const WORKSPACE_PATTERNS = [
  /((?:\/Users|\/home|\/opt|\/var|\/workspace)[^\n\r"'<>|]+?)\s+->\s+/,
  /(?:CWD|Workspace|Active Document|Active Workspaces?):\s*((?:\/Users|\/home|\/opt|\/var|\/workspace)[^\n\r"'<>|(]+)/,
  /([A-Za-z]:\\[^\n\r"'<>|]+?)\s+->\s+/,
  /(?:CWD|Workspace|Active Document|Active Workspaces?):\s*([A-Za-z]:\\[^\n\r"'<>|(]+)/,
];

const TOOL_PATH_ARG_KEYS = [
  "Path",
  "TargetFile",
  "AbsolutePath",
  "DirectoryPath",
  "SearchPath",
  "Cwd",
  "cwd",
  "path",
  "file_path",
  "directory",
];

const IGNORED_PATH_SEGMENTS = [
  "/.gemini/",
  "/.codex/",
  "/.claude/",
  "/.cursor/",
  "/.bun/",
  "/.npm/",
  "/.pnpm/",
  "/.yarn/",
  "/.local/",
  "/.cache/",
  "/.config/",
  "/.memdex/",
  "/node_modules/",
  "/tmp/",
  "/private/tmp/",
  "/var/folders/",
];
const PLACEHOLDER_PATH_RE = /(?:^|[/\\])path[/\\]to[/\\]workspace(?:$|[/\\])/i;
const WINDOWS_ABS_RE = /^[A-Za-z]:\\/;
const PROJECT_MARKERS_SECONDARY = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", ".goals"];

export function getBrainDirs() {
  if (process.env.MEMDEX_BRAIN_DIRS) {
    return process.env.MEMDEX_BRAIN_DIRS.split(path.delimiter)
      .map((p) => expandHome(p.trim()))
      .filter((p) => p && fs.existsSync(p) && fs.statSync(p).isDirectory());
  }

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
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

export function extractUserRequest(rawContent) {
  if (!rawContent) return "";
  const match = USER_REQUEST_RE.exec(rawContent);
  if (match) return match[1].trim();
  return rawContent.replace(METADATA_BLOCK_RE, "").trim();
}

function isHomeDotPath(normalizedPosix) {
  const home = (process.env.HOME || process.env.USERPROFILE || os.homedir()).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!home || !normalizedPosix.startsWith(`${home}/`)) return false;
  const rel = normalizedPosix.slice(home.length + 1);
  return rel.startsWith(".");
}

function isIgnoredWorkspacePath(pathStr) {
  if (!pathStr || typeof pathStr !== "string") return true;
  const normalized = pathStr.replace(/\\/g, "/").trim();
  if (!normalized || normalized === "/" || PLACEHOLDER_PATH_RE.test(normalized)) return true;
  const home = (process.env.HOME || process.env.USERPROFILE || os.homedir()).replace(/\\/g, "/").replace(/\/+$/, "");
  if (home && (normalized === home || isHomeDotPath(normalized))) return true;
  if (normalized.startsWith("/tmp/") || normalized === "/tmp" || normalized.startsWith("/private/tmp/")) {
    return true;
  }
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
      return normalizeWorkspace(path.dirname(candidate));
    }
    return normalizeWorkspace(candidate);
  }
  return null;
}

function unwrapArgValue(value) {
  if (typeof value !== "string") return "";
  let str = value.trim();
  if (str.length >= 2 && str.startsWith('"') && str.endsWith('"')) {
    try {
      const parsed = JSON.parse(str);
      if (typeof parsed === "string") str = parsed.trim();
    } catch {
      str = str.slice(1, -1).trim();
    }
  }
  return str;
}

function inferProjectRoot(candidatePath) {
  if (!candidatePath) return null;
  if (WINDOWS_ABS_RE.test(candidatePath)) {
    const hasExt = path.win32.extname(candidatePath) && !candidatePath.endsWith("\\");
    return normalizeWorkspace(hasExt ? path.win32.dirname(candidatePath) : candidatePath);
  }

  let dir = candidatePath;
  let exists = false;
  try {
    if (fs.existsSync(candidatePath)) {
      exists = true;
      const stat = fs.statSync(candidatePath);
      dir = stat.isFile() ? path.dirname(candidatePath) : candidatePath;
      dir = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
    }
  } catch {
    exists = false;
  }

  if (!exists) {
    const base = path.basename(candidatePath);
    const looksLikeFile = (base.includes(".") && !base.startsWith(".")) || base.startsWith(".git");
    dir = looksLikeFile && !candidatePath.endsWith("/") ? path.dirname(candidatePath) : candidatePath;
    return normalizeWorkspace(dir);
  }

  const home = normalizeWorkspace(process.env.HOME || process.env.USERPROFILE || os.homedir());
  let current = dir;
  let secondaryMatch = null;

  while (current && current !== "/" && current !== home) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return normalizeWorkspace(current);
    }
    if (!secondaryMatch) {
      for (const marker of PROJECT_MARKERS_SECONDARY) {
        if (fs.existsSync(path.join(current, marker))) {
          secondaryMatch = current;
          break;
        }
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return normalizeWorkspace(secondaryMatch || dir);
}

/**
 * Extract structured workspace path candidates from step.tool_calls (ignoring GENERIC dumps and dot-dirs).
 */
export function extractPathsFromToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const extracted = [];
  for (const call of toolCalls) {
    const args = call?.args;
    if (!args || typeof args !== "object") continue;
    for (const key of TOOL_PATH_ARG_KEYS) {
      if (!(key in args)) continue;
      const rawPath = unwrapArgValue(args[key]);
      if (!rawPath) continue;
      if (!rawPath.startsWith("/") && !WINDOWS_ABS_RE.test(rawPath)) continue;
      if (isIgnoredWorkspacePath(rawPath)) continue;
      extracted.push(rawPath);
    }
  }
  return extracted;
}

function selectDominantWorkspace(rawPaths) {
  if (!rawPaths || rawPaths.length === 0) return null;

  const rootVotes = new Map();
  const rootOrder = [];

  for (const rawPath of rawPaths) {
    const root = inferProjectRoot(rawPath);
    if (!root || root === DEFAULT_WORKSPACE || isIgnoredWorkspacePath(root)) continue;
    if (!rootVotes.has(root)) {
      rootOrder.push(root);
      rootVotes.set(root, 0);
    }
    rootVotes.set(root, rootVotes.get(root) + 1);
  }

  if (rootVotes.size === 0) return null;

  // Roll child subdirs up into an already-voted parent root (handles renamed/non-existent repos).
  const consolidated = new Map();
  for (const root of rootOrder) {
    let target = root;
    for (const candidate of rootOrder) {
      if (candidate === root) continue;
      const sep = WINDOWS_ABS_RE.test(candidate) ? "\\" : "/";
      if (root.startsWith(`${candidate}${sep}`) && candidate.length < target.length) {
        target = candidate;
      }
    }
    consolidated.set(target, (consolidated.get(target) || 0) + rootVotes.get(root));
  }

  let bestRoot = null;
  let bestCount = -1;
  for (const root of rootOrder) {
    const count = consolidated.get(root);
    if (count === undefined) continue;
    if (count > bestCount) {
      bestCount = count;
      bestRoot = root;
    }
  }
  return bestRoot;
}

export function parseTranscriptFile(logFile, workspaceHint = null) {
  let workspace =
    workspaceHint && workspaceHint.trim() && workspaceHint.trim() !== DEFAULT_WORKSPACE
      ? normalizeWorkspace(workspaceHint)
      : "";
  let lastUpdated = "";
  const messages = [];
  const toolCallPaths = [];

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

    if (!workspace && Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
      toolCallPaths.push(...extractPathsFromToolCalls(step.tool_calls));
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

  if (!workspace && toolCallPaths.length > 0) {
    const inferred = selectDominantWorkspace(toolCallPaths);
    if (inferred) workspace = inferred;
  }

  if (!workspace) {
    workspace = DEFAULT_WORKSPACE;
  }
  if (!lastUpdated) {
    const stat = fs.statSync(logFile);
    lastUpdated = new Date(stat.mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  return {
    workspace,
    workspaceSlug: workspaceToSlug(workspace),
    lastUpdated,
    messages,
  };
}

/**
 * Host-agnostic normalized conversation upsert (preserves dreamed_at & dreamed_msg_count).
 */
export function upsertConversationRecord(
  db,
  {
    id,
    source = DEFAULT_SOURCE,
    workspace = DEFAULT_WORKSPACE,
    lastUpdated = "",
    sourcePath = "",
    fileMtime = 0,
    fileSize = 0,
    messages = [],
  }
) {
  if (!id || !Array.isArray(messages) || messages.length === 0) return "empty";

  const canonicalWs = normalizeWorkspace(workspace);
  const wsSlug = workspaceToSlug(canonicalWs);
  const cleanSource = typeof source === "string" && source.trim() ? source.trim() : DEFAULT_SOURCE;
  const effectiveUpdated =
    lastUpdated || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const upsertConv = db.prepare(`
    INSERT INTO conversations (
      id, source, workspace, workspace_slug, last_updated,
      source_path, file_mtime, file_size, message_count
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      workspace = excluded.workspace,
      workspace_slug = excluded.workspace_slug,
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
    upsertConv.run(
      id,
      cleanSource,
      canonicalWs,
      wsSlug,
      effectiveUpdated,
      sourcePath,
      fileMtime,
      fileSize,
      messages.length
    );
    deleteOld.run(id);
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      insertMsg.run(
        id,
        Number.isInteger(msg.stepIndex) ? msg.stepIndex : i,
        msg.role,
        msg.content,
        msg.timestamp || effectiveUpdated
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return "updated";
}

export function syncConversation(
  db,
  convId,
  logFile,
  { workspaceHint = null, source = DEFAULT_SOURCE, force = false } = {}
) {
  if (!fs.existsSync(logFile)) return "empty";

  const stat = fs.statSync(logFile);
  const fileMtime = stat.mtimeMs;
  const fileSize = stat.size;

  const existing = db
    .prepare("SELECT workspace, file_mtime, file_size FROM conversations WHERE id = ?")
    .get(convId);

  const normalizedHint =
    workspaceHint && workspaceHint.trim() && workspaceHint.trim() !== DEFAULT_WORKSPACE
      ? normalizeWorkspace(workspaceHint)
      : null;

  const hasBetterWorkspace =
    Boolean(normalizedHint) &&
    existing &&
    existing.workspace === DEFAULT_WORKSPACE &&
    normalizedHint !== DEFAULT_WORKSPACE;

  if (
    !force &&
    existing &&
    !hasBetterWorkspace &&
    Math.abs(existing.file_mtime - fileMtime) < 1e-3 &&
    existing.file_size === fileSize
  ) {
    return "skipped";
  }

  let effectiveHint = normalizedHint;
  if (!effectiveHint && existing && existing.workspace !== DEFAULT_WORKSPACE) {
    effectiveHint = existing.workspace;
  }

  const { workspace, lastUpdated, messages } = parseTranscriptFile(logFile, effectiveHint);
  if (messages.length === 0) return "empty";

  return upsertConversationRecord(db, {
    id: convId,
    source,
    workspace,
    lastUpdated,
    sourcePath: logFile,
    fileMtime,
    fileSize,
    messages,
  });
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
      const status = syncConversation(db, entry.name, logFile, { force, source: DEFAULT_SOURCE });
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

function appendScopeFilters(where, params, { project, source, excludeConversationId, excludeIds }) {
  if (project) {
    where.push("(instr(lower(c.workspace), lower(?)) > 0 OR instr(lower(c.workspace_slug), lower(?)) > 0)");
    params.push(project, project);
  }
  if (source) {
    where.push("lower(c.source) = lower(?)");
    params.push(source);
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
}

function runFtsQuery(db, ftsExpr, shortTerms, filters, limit) {
  const where = ["messages_fts MATCH ?"];
  const params = [ftsExpr];

  for (const term of shortTerms) {
    where.push("instr(lower(m.content), lower(?)) > 0");
    params.push(term);
  }
  appendScopeFilters(where, params, filters);

  const sql = `
    SELECT m.id, m.conversation_id, m.step_index, c.source, c.workspace, c.workspace_slug,
           m.role, m.content, m.timestamp,
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

function runLikeQuery(db, terms, matchAll, filters, limit) {
  const joiner = matchAll ? " AND " : " OR ";
  const termExpr = terms.map(() => "instr(lower(m.content), lower(?)) > 0").join(joiner);
  const where = [`(${termExpr})`];
  const params = [...terms];

  appendScopeFilters(where, params, filters);

  const sql = `
    SELECT m.id, m.conversation_id, m.step_index, c.source, c.workspace, c.workspace_slug,
           m.role, m.content, m.timestamp,
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

export function searchMessages(
  db,
  query,
  { project = "", source = "", limit = 5, excludeConversationId = "", now = new Date() } = {}
) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 50));
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return [];

  const trigramTerms = terms.filter((t) => t.length >= 3);
  const shortTerms = terms.filter((t) => t.length < 3);

  const rows = [];
  const seenIds = new Set();
  const baseFilters = { project, source, excludeConversationId, excludeIds: seenIds };

  if (trigramTerms.length > 0) {
    const andExpr = trigramTerms.map(quoteFtsTerm).join(" AND ");
    for (const row of runFtsQuery(db, andExpr, shortTerms, baseFilters, safeLimit)) {
      rows.push(row);
      seenIds.add(row.id);
    }

    if (rows.length < safeLimit && (trigramTerms.length > 1 || shortTerms.length > 0)) {
      const orExpr = trigramTerms.map(quoteFtsTerm).join(" OR ");
      const remaining = safeLimit - rows.length;
      for (const row of runFtsQuery(db, orExpr, [], baseFilters, remaining)) {
        rows.push(row);
        seenIds.add(row.id);
      }
    }
  }

  if (rows.length < safeLimit && shortTerms.length > 0) {
    const remaining = safeLimit - rows.length;
    for (const row of runLikeQuery(db, shortTerms, true, baseFilters, remaining)) {
      rows.push(row);
      seenIds.add(row.id);
    }

    if (rows.length < safeLimit && shortTerms.length > 1) {
      const stillRemaining = safeLimit - rows.length;
      for (const row of runLikeQuery(db, shortTerms, false, baseFilters, stillRemaining)) {
        rows.push(row);
        seenIds.add(row.id);
      }
    }
  }

  return rows.map((row) => {
    const staleness = computeStaleness(row.timestamp, { now });
    return {
      id: row.id,
      conversationId: row.conversation_id,
      stepIndex: row.step_index,
      source: row.source || DEFAULT_SOURCE,
      workspace: row.workspace,
      workspaceSlug: row.workspace_slug || workspaceToSlug(row.workspace),
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      rank: Number(row.rank),
      snippet: extractSnippet(row.content, terms),
      ...staleness,
    };
  });
}

/**
 * L2-first hybrid search across distilled Markdown notes (L2) and raw conversation messages (L3).
 */
export function searchHybrid(
  db,
  query,
  {
    project = "",
    source = "",
    scope = "",
    type = "",
    layer = "all",
    limit = 5,
    excludeConversationId = "",
    now = new Date(),
  } = {}
) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 50));
  const includeNotes = layer !== "conversations" && !source;
  const includeMessages = layer !== "notes" && !scope && !type;

  const notes = includeNotes
    ? searchNotes(db, query, { project, scope, type, limit: safeLimit, now })
    : [];
  const messages = includeMessages
    ? searchMessages(db, query, { project, source, limit: safeLimit, excludeConversationId, now })
    : [];

  return { notes, messages };
}

export function listConversations(db, { limit = 10, project = "", source = "", now = new Date() } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const where = [];
  const params = [];
  if (project) {
    where.push("(instr(lower(c.workspace), lower(?)) > 0 OR instr(lower(c.workspace_slug), lower(?)) > 0)");
    params.push(project, project);
  }
  if (source) {
    where.push("lower(c.source) = lower(?)");
    params.push(source);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(safeLimit);

  const rows = db
    .prepare(`
      SELECT c.id, c.source, c.workspace, c.workspace_slug, c.last_updated, c.message_count,
             c.dreamed_at, c.dreamed_msg_count,
             (SELECT m.content FROM messages m
              WHERE m.conversation_id = c.id AND m.role = 'USER'
              ORDER BY m.step_index ASC, m.id ASC LIMIT 1) AS first_user_message
      FROM conversations c
      ${whereSql}
      ORDER BY c.last_updated DESC
      LIMIT ?
    `)
    .all(...params);

  return rows.map((row) => {
    let preview = (row.first_user_message || "").replace(/\s+/g, " ").trim();
    if (preview.length > 120) preview = `${preview.slice(0, 120)}...`;
    const staleness = computeStaleness(row.last_updated, { now });
    return {
      conversationId: row.id,
      source: row.source || DEFAULT_SOURCE,
      workspace: row.workspace,
      workspaceSlug: row.workspace_slug || workspaceToSlug(row.workspace),
      lastUpdated: row.last_updated,
      messageCount: row.message_count,
      dreamedAt: row.dreamed_at || "",
      dreamedMsgCount: row.dreamed_msg_count || 0,
      summary: preview,
      ...staleness,
    };
  });
}

export function getConversationMessages(db, conversationId, { maxMessages = 20, now = new Date() } = {}) {
  const safeMax = Math.max(1, Math.min(Number(maxMessages) || 20, 100));
  const conv = db
    .prepare(`
      SELECT id, source, workspace, workspace_slug, last_updated, message_count,
             dreamed_at, dreamed_msg_count
      FROM conversations
      WHERE id = ?
    `)
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

  const staleness = computeStaleness(conv.last_updated, { now });

  return {
    conversation: {
      id: conv.id,
      source: conv.source || DEFAULT_SOURCE,
      workspace: conv.workspace,
      workspaceSlug: conv.workspace_slug || workspaceToSlug(conv.workspace),
      lastUpdated: conv.last_updated,
      messageCount: conv.message_count,
      dreamedAt: conv.dreamed_at || "",
      dreamedMsgCount: conv.dreamed_msg_count || 0,
      ...staleness,
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
    const logPath = resolveHookLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] ${err?.stack || err}\n`, "utf8");
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
        syncConversation(db, convId, logFile, { workspaceHint, source: DEFAULT_SOURCE });
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
  const opts = { hook: false, force: false, project: "", source: "", limit: 5, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hook") opts.hook = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--project" && argv[i + 1]) opts.project = argv[++i];
    else if (arg === "--source" && argv[i + 1]) opts.source = argv[++i];
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
      process.stdout.write(`${JSON.stringify({ dbPath: resolveDbPath(), ...stats }, null, 2)}\n`);
    } else if (action === "search") {
      const query = rest.join(" ").trim();
      if (!query) {
        process.stderr.write("Error: Please provide a search query.\n");
        process.exit(1);
      }
      const results = searchMessages(db, query, {
        project: opts.project,
        source: opts.source,
        limit: opts.limit,
      });
      if (results.length === 0) {
        process.stdout.write(`No results found for: ${query}\n`);
        return;
      }
      for (const item of results) {
        const staleTag = item.stalenessNote ? ` | WARN: ${item.stalenessNote}` : "";
        process.stdout.write(
          `[${item.timestamp} (${item.ageLabel})] [${item.source}] ${item.workspace} | ${item.role} (conv=${item.conversationId}, rank=${item.rank.toFixed(2)})${staleTag}\n`
        );
        process.stdout.write(`${item.snippet}\n${"-".repeat(50)}\n`);
      }
    } else if (action === "list") {
      const convs = listConversations(db, {
        limit: opts.limit,
        project: opts.project,
        source: opts.source,
      });
      for (const item of convs) {
        process.stdout.write(
          `[${item.lastUpdated} (${item.ageLabel})] [${item.source}] ${item.conversationId} | ${item.workspace} (${item.messageCount} msgs) — ${item.summary}\n`
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
