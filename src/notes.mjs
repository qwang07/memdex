/**
 * Memdex L2 Distilled Memory Store:
 * - Human-readable Markdown notes with YAML Frontmatter under `~/.memdex/notes/`
 *   - `global/<slug>.md` + `global/MEMORY.md` (max 50 lines)
 *   - `projects/<workspace-slug>/<slug>.md` + `projects/<workspace-slug>/MEMORY.md` (max 100 lines)
 * - Combined progressive disclosure budget: <= 150 lines AND <= 8192 UTF-8 bytes
 * - Synchronized SQLite `notes` + `notes_fts` (trigram) search with freshness/staleness warnings
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { computeStaleness } from "./db.mjs";
import {
  DEFAULT_WORKSPACE,
  GLOBAL_SLUG,
  normalizeWorkspace,
  resolveNotesDir,
  workspaceToSlug,
} from "./paths.mjs";

export const NOTE_TYPES = ["user", "feedback", "project", "reference"];
export const NOTE_SCOPES = ["global", "project"];
export const GLOBAL_INDEX_MAX_LINES = 50;
export const PROJECT_INDEX_MAX_LINES = 100;
export const TOTAL_INDEX_MAX_LINES = 150;
export const TOTAL_INDEX_MAX_BYTES = 8192;

const NOTE_TYPE_SET = new Set(NOTE_TYPES);
const NOTE_SCOPE_SET = new Set(NOTE_SCOPES);
const QUERY_SPLIT_RE = /[\s,，。、;；:：?!？！/\\()（）[\]【】"'`<>《》]+/;
const SAFE_SLUG_SEGMENT_RE = /^[a-z0-9\u4e00-\u9fff][a-z0-9\u4e00-\u9fff_-]{0,63}$/i;
const SAFE_WS_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function sanitizeNoteSlug(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  let slug = raw
    .toLowerCase()
    .replace(/[/\\]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);

  if (!slug || slug === "memory" || slug === "." || slug === "..") {
    const hash = crypto
      .createHash("sha256")
      .update(raw || String(Date.now()))
      .digest("hex")
      .slice(0, 8);
    slug = `note-${hash}`;
  }
  return slug;
}

export function buildNoteId(scope, workspaceSlug, slug) {
  if (scope === "global") {
    return `global/${slug}`;
  }
  return `projects/${workspaceSlug}/${slug}`;
}

export function parseNoteId(id) {
  if (typeof id !== "string") return null;
  const trimmed = id.trim().replace(/\.md$/i, "");
  const parts = trimmed.split("/");

  if (parts.length === 2 && parts[0] === "global") {
    const slug = parts[1];
    if (!SAFE_SLUG_SEGMENT_RE.test(slug) || slug.toLowerCase() === "memory") return null;
    return { scope: "global", workspaceSlug: GLOBAL_SLUG, slug, id: `global/${slug}` };
  }

  if (parts.length === 3 && parts[0] === "projects") {
    const [, wsSlug, slug] = parts;
    if (!SAFE_WS_SLUG_RE.test(wsSlug) || !SAFE_SLUG_SEGMENT_RE.test(slug) || slug.toLowerCase() === "memory") {
      return null;
    }
    return { scope: "project", workspaceSlug: wsSlug, slug, id: `projects/${wsSlug}/${slug}` };
  }

  return null;
}

export function getScopeDir(notesDir, scope, workspaceSlug = GLOBAL_SLUG) {
  const base = resolveNotesDir(notesDir);
  if (scope === "global") {
    return path.join(base, "global");
  }
  return path.join(base, "projects", workspaceSlug);
}

export function getNoteFilePath(notesDir, scope, workspaceSlug, slug) {
  return path.join(getScopeDir(notesDir, scope, workspaceSlug), `${slug}.md`);
}

export function getIndexFilePath(notesDir, scope, workspaceSlug = GLOBAL_SLUG) {
  return path.join(getScopeDir(notesDir, scope, workspaceSlug), "MEMORY.md");
}

function formatYamlScalar(value) {
  const str = String(value ?? "").replace(/\r?\n/g, " ").trim();
  if (
    !str ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(str) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(str) ||
    /[:#\t]/.test(str)
  ) {
    return JSON.stringify(str);
  }
  return str;
}

function parseYamlScalar(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : String(parsed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function parseYamlStringArray(raw) {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[]") return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean);
      }
    } catch {
      const inner = trimmed.slice(1, -1).trim();
      if (!inner) return [];
      return inner
        .split(",")
        .map((s) => parseYamlScalar(s))
        .filter(Boolean);
    }
  }
  return [parseYamlScalar(trimmed)].filter(Boolean);
}

export function serializeNoteMarkdown({
  name,
  description,
  type,
  scope,
  workspace = DEFAULT_WORKSPACE,
  updated,
  sources = [],
  content = "",
}) {
  const lines = [
    "---",
    `name: ${formatYamlScalar(name)}`,
    `description: ${formatYamlScalar(description)}`,
    `type: ${type}`,
    `scope: ${scope}`,
  ];
  if (scope === "project") {
    lines.push(`workspace: ${formatYamlScalar(workspace)}`);
  }
  lines.push(`updated: ${formatYamlScalar(updated)}`);
  const cleanSources = Array.isArray(sources)
    ? [...new Set(sources.map((s) => String(s).trim()).filter(Boolean))]
    : [];
  lines.push(`sources: ${JSON.stringify(cleanSources)}`);
  lines.push("---", "");

  const body = String(content ?? "").trim();
  if (body) {
    lines.push(body, "");
  }
  return lines.join("\n");
}

export function parseNoteMarkdown(rawText) {
  if (typeof rawText !== "string") return null;
  const text = rawText.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    return { frontmatter: {}, content: text.trim() };
  }
  const endIdx = text.indexOf("\n---", 4);
  if (endIdx === -1) {
    return { frontmatter: {}, content: text.trim() };
  }

  const fmBlock = text.slice(4, endIdx);
  const afterEnd = text.slice(endIdx + 4);
  const body = afterEnd.startsWith("\n") ? afterEnd.slice(1).trim() : afterEnd.trim();

  const fm = {};
  let currentListKey = null;

  for (const line of fmBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (currentListKey && /^\s*-\s+/.test(line)) {
      const item = parseYamlScalar(line.replace(/^\s*-\s+/, ""));
      if (item) fm[currentListKey].push(item);
      continue;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const valRaw = line.slice(colonIdx + 1).trim();
    currentListKey = null;

    if (key === "sources") {
      if (!valRaw) {
        fm.sources = [];
        currentListKey = "sources";
      } else {
        fm.sources = parseYamlStringArray(valRaw);
      }
    } else {
      fm[key] = parseYamlScalar(valRaw);
    }
  }

  return { frontmatter: fm, content: body };
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function compactSingleLine(str, maxChars = 140) {
  const clean = String(str ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 1)}…`;
}

function formatDateOnly(isoStr) {
  if (typeof isoStr !== "string" || !isoStr.trim()) return "unknown";
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(isoStr.trim());
  return match ? match[1] : isoStr.slice(0, 10);
}

/**
 * Render a scope's MEMORY.md index text with strict line budget enforcement.
 */
export function renderScopeIndex(notes, { scope, workspace = DEFAULT_WORKSPACE, maxLines } = {}) {
  const budget = maxLines ?? (scope === "global" ? GLOBAL_INDEX_MAX_LINES : PROJECT_INDEX_MAX_LINES);
  if (!Array.isArray(notes) || notes.length === 0) {
    return {
      text: "",
      lineCount: 0,
      totalNotes: 0,
      includedNotes: 0,
      omittedNotes: 0,
      truncated: false,
    };
  }

  const header =
    scope === "global"
      ? "# Memdex Global Memory Index"
      : `# Memdex Project Memory Index (${workspace})`;

  const formatEntry = (note) => {
    const name = compactSingleLine(note.name, 60);
    const desc = compactSingleLine(note.description, 120);
    const date = formatDateOnly(note.updated);
    return `- [${note.type}] \`${note.id}\` — ${name}: ${desc} (${date})`;
  };

  if (1 + notes.length <= budget) {
    const lines = [header, ...notes.map(formatEntry)];
    return {
      text: `${lines.join("\n")}\n`,
      lineCount: lines.length,
      totalNotes: notes.length,
      includedNotes: notes.length,
      omittedNotes: 0,
      truncated: false,
    };
  }

  const maxEntries = Math.max(0, budget - 2);
  const included = notes.slice(0, maxEntries);
  const omitted = notes.length - included.length;
  const lines = [
    header,
    ...included.map(formatEntry),
    `... (+${omitted} older note(s) omitted; use search_past_memory or dream to prune)`,
  ];

  return {
    text: `${lines.join("\n")}\n`,
    lineCount: lines.length,
    totalNotes: notes.length,
    includedNotes: included.length,
    omittedNotes: omitted,
    truncated: true,
  };
}

/**
 * Rebuild and atomically write MEMORY.md for one scope (global or a project slug).
 * Deletes MEMORY.md if the scope has 0 notes left so SessionStart stays cleanly silent.
 */
export function rebuildScopeIndex(
  db,
  { scope, workspace = DEFAULT_WORKSPACE, workspaceSlug = GLOBAL_SLUG, notesDir = null, maxLines = null }
) {
  const resolvedScope = scope === "project" ? "project" : "global";
  const resolvedWs = resolvedScope === "project" ? normalizeWorkspace(workspace) : DEFAULT_WORKSPACE;
  const resolvedSlug = resolvedScope === "project" ? workspaceSlug || workspaceToSlug(resolvedWs) : GLOBAL_SLUG;
  const limitLines = maxLines ?? (resolvedScope === "global" ? GLOBAL_INDEX_MAX_LINES : PROJECT_INDEX_MAX_LINES);

  const rows = db
    .prepare(`
      SELECT id, scope, workspace, workspace_slug, slug, type, name, description, updated
      FROM notes
      WHERE scope = ? AND workspace_slug = ?
      ORDER BY updated DESC, id ASC
    `)
    .all(resolvedScope, resolvedSlug);

  const effectiveWorkspace =
    resolvedWs !== DEFAULT_WORKSPACE ? resolvedWs : rows[0]?.workspace || DEFAULT_WORKSPACE;

  const rendered = renderScopeIndex(rows, {
    scope: resolvedScope,
    workspace: effectiveWorkspace,
    maxLines: limitLines,
  });

  const indexPath = getIndexFilePath(notesDir, resolvedScope, resolvedSlug);
  if (rendered.totalNotes === 0) {
    if (fs.existsSync(indexPath)) {
      fs.rmSync(indexPath, { force: true });
    }
    return { ...rendered, indexPath };
  }

  writeFileAtomic(indexPath, rendered.text);
  return { ...rendered, indexPath };
}

function truncateLinesToBudget(lines, maxLines, footer) {
  if (lines.length <= maxLines) {
    return { lines, truncated: false };
  }
  const keep = Math.max(0, maxLines - 1);
  return { lines: [...lines.slice(0, keep), footer], truncated: true };
}

function sliceUtf8ToBytes(str, maxBytes) {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  // Walk back past UTF-8 continuation bytes (10xxxxxx) so we never split a multi-byte char.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}

function enforceCombinedBudget(rawText, { maxTotalLines = TOTAL_INDEX_MAX_LINES, maxTotalBytes = TOTAL_INDEX_MAX_BYTES }) {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { text: "", lines: 0, bytes: 0, truncated: false };
  }

  let lines = trimmed.split("\n");
  let truncated = false;
  const lineFooter = `... (truncated to ${maxTotalLines}-line budget; use search_past_memory for older notes)`;
  const byteFooter = `... (truncated to ${maxTotalBytes}B budget; use search_past_memory for older notes)`;

  if (lines.length > maxTotalLines) {
    lines = [...lines.slice(0, Math.max(0, maxTotalLines - 1)), lineFooter];
    truncated = true;
  }

  let text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") > maxTotalBytes) {
    truncated = true;
    const bodyLines = lines.slice();
    // Remove an existing line-truncation footer if present before byte trimming.
    if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === lineFooter) {
      bodyLines.pop();
    }
    const footerBytes = Buffer.byteLength(`\n${byteFooter}`, "utf8");
    const allowedBodyBytes = Math.max(0, maxTotalBytes - footerBytes);

    const kept = [];
    let usedBytes = 0;
    for (const line of bodyLines) {
      if (kept.length >= maxTotalLines - 1) break;
      const lineBytes = Buffer.byteLength(kept.length === 0 ? line : `\n${line}`, "utf8");
      if (usedBytes + lineBytes > allowedBodyBytes) break;
      kept.push(line);
      usedBytes += lineBytes;
    }

    if (kept.length === 0) {
      text = sliceUtf8ToBytes(byteFooter, maxTotalBytes);
    } else {
      text = `${kept.join("\n")}\n${byteFooter}`;
    }
  }

  const finalLines = text ? text.split("\n").length : 0;
  const finalBytes = Buffer.byteLength(text, "utf8");
  return { text, lines: finalLines, bytes: finalBytes, truncated };
}

function readSectionIndexLines(indexPath, maxLines, footer) {
  if (!fs.existsSync(indexPath)) {
    return { lines: [], count: 0, truncated: false };
  }
  const raw = fs.readFileSync(indexPath, "utf8").trim();
  if (!raw) return { lines: [], count: 0, truncated: false };

  const allLines = raw.split("\n");
  const noteCount = allLines.filter((l) => l.startsWith("- [")).length;
  const capped = truncateLinesToBudget(allLines, maxLines, footer);
  return { lines: capped.lines, count: noteCount, truncated: capped.truncated };
}

/**
 * Assemble the scoped MEMORY.md index for SessionStart disclosure or MCP get_memory_index.
 * - With workspace: global (<=50 lines) + current project (<=100 lines)
 * - Without workspace: global only (<=50 lines), never any project index
 * - Combined hard caps: <=150 lines AND <=8192 UTF-8 bytes; empty scopes produce empty text.
 */
export function getMemoryIndex({
  workspace = "",
  notesDir = null,
  maxGlobalLines = GLOBAL_INDEX_MAX_LINES,
  maxProjectLines = PROJECT_INDEX_MAX_LINES,
  maxTotalLines = TOTAL_INDEX_MAX_LINES,
  maxTotalBytes = TOTAL_INDEX_MAX_BYTES,
} = {}) {
  const canonicalWs = normalizeWorkspace(workspace);
  const wsSlug = workspaceToSlug(canonicalWs);
  const hasProject = canonicalWs !== DEFAULT_WORKSPACE && wsSlug !== GLOBAL_SLUG;

  const globalPath = getIndexFilePath(notesDir, "global", GLOBAL_SLUG);
  const globalSection = readSectionIndexLines(
    globalPath,
    maxGlobalLines,
    `... (global index truncated to ${maxGlobalLines} lines)`
  );

  let projectSection = { lines: [], count: 0, truncated: false };
  if (hasProject) {
    const projectPath = getIndexFilePath(notesDir, "project", wsSlug);
    projectSection = readSectionIndexLines(
      projectPath,
      maxProjectLines,
      `... (project index truncated to ${maxProjectLines} lines)`
    );
  }

  const parts = [];
  if (globalSection.lines.length > 0) parts.push(globalSection.lines.join("\n"));
  if (projectSection.lines.length > 0) parts.push(projectSection.lines.join("\n"));

  const combinedRaw = parts.join("\n\n");
  const enforced = enforceCombinedBudget(combinedRaw, { maxTotalLines, maxTotalBytes });

  return {
    text: enforced.text,
    empty: enforced.text.length === 0,
    lines: enforced.lines,
    bytes: enforced.bytes,
    truncated: enforced.truncated || globalSection.truncated || projectSection.truncated,
    globalTruncated: globalSection.truncated,
    projectTruncated: projectSection.truncated,
    workspace: canonicalWs,
    workspaceSlug: wsSlug,
    globalCount: globalSection.count,
    projectCount: projectSection.count,
  };
}

function hydrateNoteRow(row, { now = new Date() } = {}) {
  let sources = [];
  try {
    const parsed = JSON.parse(row.sources || "[]");
    if (Array.isArray(parsed)) sources = parsed;
  } catch {
    sources = [];
  }
  const staleness = computeStaleness(row.updated, { now });
  return {
    id: row.id,
    scope: row.scope,
    workspace: row.workspace,
    workspaceSlug: row.workspace_slug,
    slug: row.slug,
    type: row.type,
    name: row.name,
    description: row.description,
    content: row.content,
    sources,
    updated: row.updated,
    filePath: row.file_path,
    ...staleness,
  };
}

/**
 * Create or update a distilled L2 memory note (Markdown + SQLite notes/notes_fts + MEMORY.md).
 */
export function upsertMemory(
  db,
  {
    scope,
    type,
    slug,
    name,
    description,
    content,
    workspace = "",
    sources = [],
    updated = "",
    notesDir = null,
    now = new Date(),
  }
) {
  if (!NOTE_SCOPE_SET.has(scope)) {
    throw new Error(`Invalid scope '${scope}'. Expected one of: ${NOTE_SCOPES.join(", ")}`);
  }
  if (!NOTE_TYPE_SET.has(type)) {
    throw new Error(`Invalid note type '${type}'. Expected one of: ${NOTE_TYPES.join(", ")}`);
  }

  const cleanName = typeof name === "string" ? name.trim() : "";
  const cleanDesc = typeof description === "string" ? description.trim() : "";
  const cleanContent = typeof content === "string" ? content.trim() : "";
  if (!cleanName) throw new Error("Note 'name' must be non-empty.");
  if (!cleanDesc) throw new Error("Note 'description' must be non-empty.");
  if (!cleanContent) throw new Error("Note 'content' must be non-empty.");

  let canonicalWs = DEFAULT_WORKSPACE;
  let wsSlug = GLOBAL_SLUG;
  if (scope === "project") {
    canonicalWs = normalizeWorkspace(workspace);
    if (!canonicalWs || canonicalWs === DEFAULT_WORKSPACE) {
      throw new Error("Project-scoped memory requires a non-empty 'workspace' path.");
    }
    wsSlug = workspaceToSlug(canonicalWs);
  }

  const cleanSlug = sanitizeNoteSlug(slug || cleanName);
  const id = buildNoteId(scope, wsSlug, cleanSlug);
  const cleanSources = Array.isArray(sources)
    ? [...new Set(sources.map((s) => String(s).trim()).filter(Boolean))]
    : [];
  const isoUpdated =
    typeof updated === "string" && updated.trim()
      ? updated.trim()
      : now.toISOString().replace(/\.\d{3}Z$/, "Z");

  const filePath = getNoteFilePath(notesDir, scope, wsSlug, cleanSlug);
  const markdown = serializeNoteMarkdown({
    name: cleanName,
    description: cleanDesc,
    type,
    scope,
    workspace: canonicalWs,
    updated: isoUpdated,
    sources: cleanSources,
    content: cleanContent,
  });

  writeFileAtomic(filePath, markdown);

  db.prepare(`
    INSERT INTO notes (
      id, scope, workspace, workspace_slug, slug, type,
      name, description, content, sources, updated, file_path
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      scope = excluded.scope,
      workspace = excluded.workspace,
      workspace_slug = excluded.workspace_slug,
      slug = excluded.slug,
      type = excluded.type,
      name = excluded.name,
      description = excluded.description,
      content = excluded.content,
      sources = excluded.sources,
      updated = excluded.updated,
      file_path = excluded.file_path
  `).run(
    id,
    scope,
    canonicalWs,
    wsSlug,
    cleanSlug,
    type,
    cleanName,
    cleanDesc,
    cleanContent,
    JSON.stringify(cleanSources),
    isoUpdated,
    filePath
  );

  const index = rebuildScopeIndex(db, {
    scope,
    workspace: canonicalWs,
    workspaceSlug: wsSlug,
    notesDir,
  });

  const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  return {
    note: hydrateNoteRow(row, { now }),
    index,
  };
}

/**
 * Read a single L2 memory note by canonical ID (`global/<slug>` or `projects/<wsSlug>/<slug>`).
 * Falls back to disk if manually authored, and attaches freshness/staleness warnings.
 */
export function readMemory(db, id, { notesDir = null, now = new Date() } = {}) {
  const parsedId = parseNoteId(id);
  if (!parsedId) return null;

  const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(parsedId.id);
  if (row) {
    return hydrateNoteRow(row, { now });
  }

  // Fallback: load from disk if manually dropped into notes/
  const diskPath = getNoteFilePath(notesDir, parsedId.scope, parsedId.workspaceSlug, parsedId.slug);
  if (!fs.existsSync(diskPath)) return null;

  const parsed = parseNoteMarkdown(fs.readFileSync(diskPath, "utf8"));
  if (!parsed) return null;

  const fm = parsed.frontmatter;
  const stat = fs.statSync(diskPath);
  const updated = fm.updated || new Date(stat.mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const workspace =
    parsedId.scope === "project" ? normalizeWorkspace(fm.workspace || DEFAULT_WORKSPACE) : DEFAULT_WORKSPACE;

  return {
    id: parsedId.id,
    scope: parsedId.scope,
    workspace,
    workspaceSlug: parsedId.workspaceSlug,
    slug: parsedId.slug,
    type: NOTE_TYPE_SET.has(fm.type) ? fm.type : "project",
    name: fm.name || parsedId.slug,
    description: fm.description || "",
    content: parsed.content,
    sources: Array.isArray(fm.sources) ? fm.sources : [],
    updated,
    filePath: diskPath,
    ...computeStaleness(updated, { now }),
  };
}

/**
 * Delete a distilled L2 memory note from both disk and SQLite, and rebuild its scope MEMORY.md.
 */
export function deleteMemory(db, id, { notesDir = null } = {}) {
  const parsedId = parseNoteId(id);
  if (!parsedId) {
    return { deleted: false, id: String(id || ""), reason: "invalid-id", index: null };
  }

  const existing = db.prepare("SELECT id, scope, workspace, workspace_slug, file_path FROM notes WHERE id = ?").get(parsedId.id);
  const diskPath =
    existing?.file_path || getNoteFilePath(notesDir, parsedId.scope, parsedId.workspaceSlug, parsedId.slug);

  let existed = Boolean(existing);
  if (fs.existsSync(diskPath)) {
    fs.rmSync(diskPath, { force: true });
    existed = true;
  }

  if (existing) {
    db.prepare("DELETE FROM notes WHERE id = ?").run(parsedId.id);
  }

  const index = rebuildScopeIndex(db, {
    scope: parsedId.scope,
    workspace: existing?.workspace || DEFAULT_WORKSPACE,
    workspaceSlug: parsedId.workspaceSlug,
    notesDir,
  });

  return { deleted: existed, id: parsedId.id, index };
}

/**
 * Sync hand-edited Markdown notes on disk into SQLite `notes` / `notes_fts` and rebuild MEMORY.md files.
 */
export function syncNotesFromDisk(db, { notesDir = null } = {}) {
  const base = resolveNotesDir(notesDir);
  if (!fs.existsSync(base)) {
    return { scanned: 0, synced: 0, removed: 0 };
  }

  const foundIds = new Set();
  const touchedScopes = new Map();
  let scanned = 0;
  let synced = 0;

  const scanDir = (dirPath, scope, workspaceSlug) => {
    if (!fs.existsSync(dirPath)) return;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (entry.name.toLowerCase() === "memory.md") continue;

      const filePath = path.join(dirPath, entry.name);
      const slug = sanitizeNoteSlug(entry.name.slice(0, -3));
      const id = buildNoteId(scope, workspaceSlug, slug);
      scanned += 1;

      const parsed = parseNoteMarkdown(fs.readFileSync(filePath, "utf8"));
      if (!parsed || !parsed.content) continue;

      const fm = parsed.frontmatter;
      const stat = fs.statSync(filePath);
      const updated = fm.updated || new Date(stat.mtimeMs).toISOString().replace(/\.\d{3}Z$/, "Z");
      const type = NOTE_TYPE_SET.has(fm.type) ? fm.type : scope === "global" ? "user" : "project";
      const workspace = scope === "project" ? normalizeWorkspace(fm.workspace || DEFAULT_WORKSPACE) : DEFAULT_WORKSPACE;
      const sources = Array.isArray(fm.sources) ? fm.sources : [];

      db.prepare(`
        INSERT INTO notes (
          id, scope, workspace, workspace_slug, slug, type,
          name, description, content, sources, updated, file_path
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workspace = excluded.workspace,
          type = excluded.type,
          name = excluded.name,
          description = excluded.description,
          content = excluded.content,
          sources = excluded.sources,
          updated = excluded.updated,
          file_path = excluded.file_path
      `).run(
        id,
        scope,
        workspace,
        workspaceSlug,
        slug,
        type,
        fm.name || slug,
        fm.description || compactSingleLine(parsed.content, 100),
        parsed.content,
        JSON.stringify(sources),
        updated,
        filePath
      );

      foundIds.add(id);
      touchedScopes.set(`${scope}:${workspaceSlug}`, { scope, workspace, workspaceSlug });
      synced += 1;
    }
  };

  scanDir(path.join(base, "global"), "global", GLOBAL_SLUG);

  const projectsRoot = path.join(base, "projects");
  if (fs.existsSync(projectsRoot)) {
    for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      scanDir(path.join(projectsRoot, entry.name), "project", entry.name);
    }
  }

  let removed = 0;
  const existingRows = db.prepare("SELECT id, scope, workspace, workspace_slug, file_path FROM notes").all();
  for (const row of existingRows) {
    if (!foundIds.has(row.id) && row.file_path.startsWith(base)) {
      db.prepare("DELETE FROM notes WHERE id = ?").run(row.id);
      touchedScopes.set(`${row.scope}:${row.workspace_slug}`, {
        scope: row.scope,
        workspace: row.workspace,
        workspaceSlug: row.workspace_slug,
      });
      removed += 1;
    }
  }

  for (const target of touchedScopes.values()) {
    rebuildScopeIndex(db, { ...target, notesDir: base });
  }

  return { scanned, synced, removed };
}

function tokenizeNoteQuery(query) {
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

function extractNoteSnippet(note, terms, radius = 320) {
  const full = `${note.name}\n${note.description}\n${note.content}`;
  const lower = full.toLowerCase();
  let hitIdx = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx !== -1 && (hitIdx === -1 || idx < hitIdx)) {
      hitIdx = idx;
    }
  }
  if (hitIdx === -1) {
    return note.content.length > radius * 2 ? `${note.content.slice(0, radius * 2)}\n...` : note.content;
  }
  const start = Math.max(0, hitIdx - radius);
  const end = Math.min(full.length, hitIdx + radius);
  const prefix = start > 0 ? "...\n" : "";
  const suffix = end < full.length ? "\n..." : "";
  return `${prefix}${full.slice(start, end)}${suffix}`;
}

function appendNoteFilters(where, params, { project, scope, type, excludeIds }) {
  if (project) {
    where.push("(instr(lower(n.workspace), lower(?)) > 0 OR instr(lower(n.workspace_slug), lower(?)) > 0)");
    params.push(project, project);
  }
  if (scope) {
    where.push("n.scope = ?");
    params.push(scope);
  }
  if (type) {
    where.push("n.type = ?");
    params.push(type);
  }
  if (excludeIds.size > 0) {
    const ids = [...excludeIds];
    where.push(`n.rowid_id NOT IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
}

function runNotesFts(db, ftsExpr, shortTerms, filters, limit) {
  const where = ["notes_fts MATCH ?"];
  const params = [ftsExpr];
  for (const term of shortTerms) {
    where.push("instr(lower(n.name || ' ' || n.description || ' ' || n.content), lower(?)) > 0");
    params.push(term);
  }
  appendNoteFilters(where, params, filters);

  const sql = `
    SELECT n.*, bm25(notes_fts) AS rank
    FROM notes_fts
    JOIN notes n ON notes_fts.rowid = n.rowid_id
    WHERE ${where.join(" AND ")}
    ORDER BY rank ASC, n.updated DESC
    LIMIT ?
  `;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function runNotesLike(db, terms, matchAll, filters, limit) {
  const joiner = matchAll ? " AND " : " OR ";
  const expr = terms
    .map(() => "instr(lower(n.name || ' ' || n.description || ' ' || n.content), lower(?)) > 0")
    .join(joiner);
  const where = [`(${expr})`];
  const params = [...terms];
  appendNoteFilters(where, params, filters);

  const sql = `
    SELECT n.*, 0.0 AS rank
    FROM notes n
    WHERE ${where.join(" AND ")}
    ORDER BY n.updated DESC, n.rowid_id DESC
    LIMIT ?
  `;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

/**
 * Bilingual Chinese/English search over distilled L2 notes (`notes_fts` trigram + short-term fallback).
 */
export function searchNotes(
  db,
  query,
  { project = "", scope = "", type = "", limit = 5, now = new Date() } = {}
) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 50));
  const terms = tokenizeNoteQuery(query);
  if (terms.length === 0) return [];

  const trigramTerms = terms.filter((t) => t.length >= 3);
  const shortTerms = terms.filter((t) => t.length < 3);

  const rows = [];
  const seenRowIds = new Set();
  const baseFilters = { project, scope, type, excludeIds: seenRowIds };

  if (trigramTerms.length > 0) {
    const andExpr = trigramTerms.map(quoteFtsTerm).join(" AND ");
    for (const row of runNotesFts(db, andExpr, shortTerms, baseFilters, safeLimit)) {
      rows.push(row);
      seenRowIds.add(row.rowid_id);
    }

    if (rows.length < safeLimit && (trigramTerms.length > 1 || shortTerms.length > 0)) {
      const orExpr = trigramTerms.map(quoteFtsTerm).join(" OR ");
      for (const row of runNotesFts(db, orExpr, [], baseFilters, safeLimit - rows.length)) {
        rows.push(row);
        seenRowIds.add(row.rowid_id);
      }
    }
  }

  if (rows.length < safeLimit && shortTerms.length > 0) {
    for (const row of runNotesLike(db, shortTerms, true, baseFilters, safeLimit - rows.length)) {
      rows.push(row);
      seenRowIds.add(row.rowid_id);
    }
    if (rows.length < safeLimit && shortTerms.length > 1) {
      for (const row of runNotesLike(db, shortTerms, false, baseFilters, safeLimit - rows.length)) {
        rows.push(row);
        seenRowIds.add(row.rowid_id);
      }
    }
  }

  return rows.map((row) => {
    const hydrated = hydrateNoteRow(row, { now });
    return {
      ...hydrated,
      rank: Number(row.rank),
      snippet: extractNoteSnippet(hydrated, terms),
    };
  });
}

export function listNotes(db, { scope = "", project = "", type = "", limit = 50, now = new Date() } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const where = [];
  const params = [];
  if (scope) {
    where.push("scope = ?");
    params.push(scope);
  }
  if (project) {
    where.push("(instr(lower(workspace), lower(?)) > 0 OR instr(lower(workspace_slug), lower(?)) > 0)");
    params.push(project, project);
  }
  if (type) {
    where.push("type = ?");
    params.push(type);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(safeLimit);

  const rows = db
    .prepare(`SELECT * FROM notes ${whereSql} ORDER BY updated DESC, id ASC LIMIT ?`)
    .all(...params);
  return rows.map((row) => hydrateNoteRow(row, { now }));
}
