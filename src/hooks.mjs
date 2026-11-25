/**
 * Memdex thin Hook adapter layer for SessionStart and Stop across host protocols:
 * - Antigravity: stdin `workspacePaths[0]` -> stdout `{ injectSteps: [{ systemMessage: { systemMessage } }] }`
 * - Claude Code: stdin `cwd` -> stdout `{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }`
 * - Codex:       stdin `cwd` -> same `hookSpecificOutput` shape as Claude Code
 * - Gemini CLI:  stdin `cwd` -> stdout `{ hookSpecificOutput: { additionalContext } }`
 * - Plain JSON:  stdin `workspace` | `cwd` | `workspacePaths[0]` -> stdout `{ additionalContext }`
 *
 * Guarantees:
 * - Only reads scoped L2 MEMORY.md indexes (never L2 note bodies) with strict line/byte caps.
 * - Dual-threshold consolidation reminder (>=5 unsynthesized sessions AND >=24h since last dream),
 *   purely read-only against existing SQLite `dreamed_at` / `dreamed_msg_count` columns.
 * - Silent `{}` on empty store or on any internal/parse error (never emits non-JSON to stdout).
 */

import fs from "node:fs";
import process from "node:process";
import { supportsSqliteReadOnly } from "./db.mjs";
import { PENDING_DREAM_SQL } from "./dream.mjs";

import {
  getMemoryIndex,
  GLOBAL_INDEX_MAX_LINES,
  PROJECT_INDEX_MAX_LINES,
  TOTAL_INDEX_MAX_BYTES,
  TOTAL_INDEX_MAX_LINES,
} from "./notes.mjs";
import { disablesAutomaticAntigravityMemory, openSqliteDatabase, resolveDbPath } from "./paths.mjs";
import { logHookError, syncAntigravityStopPayload, syncHostStopPayload } from "../scripts/harness.mjs";

export const SUPPORTED_HOOK_HOSTS = ["antigravity", "claude", "codex", "gemini", "plain"];
export const DEFAULT_HOOK_HOST = "antigravity";

export const DREAM_MIN_UNSYNTHESIZED_SESSIONS = 5;
export const DREAM_MIN_INTERVAL_HOURS = 24;
export const DREAM_MIN_INTERVAL_MS = DREAM_MIN_INTERVAL_HOURS * 60 * 60 * 1000;

const HOST_ALIASES = new Map([
  ["antigravity", "antigravity"],
  ["claude", "claude"],
  ["claude-code", "claude"],
  ["codex", "codex"],
  ["gemini", "gemini"],
  ["gemini-cli", "gemini"],
  ["plain", "plain"],
]);

export function normalizeHookHost(rawHost, fallback = DEFAULT_HOOK_HOST) {
  if (rawHost === undefined || rawHost === null || String(rawHost).trim() === "") {
    return fallback;
  }
  const key = String(rawHost).trim().toLowerCase();
  return HOST_ALIASES.get(key) || null;
}

function firstNonEmptyString(values) {
  if (!Array.isArray(values)) return "";
  for (const item of values) {
    if (typeof item === "string" && item.trim()) {
      return item.trim();
    }
  }
  return "";
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Extract the workspace path from a host-specific SessionStart stdin payload.
 * Never falls back to `process.cwd()` so global-only sessions stay strictly global.
 */
export function extractHookWorkspace(host, payload, explicitWorkspace = "") {
  const override = cleanString(explicitWorkspace);
  if (override) return override;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";

  if (host === "antigravity") {
    return firstNonEmptyString(payload.workspacePaths);
  }
  if (host === "claude" || host === "codex" || host === "gemini") {
    return cleanString(payload.cwd);
  }
  if (host === "plain") {
    return (
      cleanString(payload.workspace) ||
      cleanString(payload.cwd) ||
      firstNonEmptyString(payload.workspacePaths)
    );
  }
  return "";
}

export { supportsSqliteReadOnly };

/**
 * Evaluate the read-only dual-threshold consolidation reminder against existing SQLite columns:
 * - Count gate: unsynthesized conversations >= 5 (never dreamed OR message_count > dreamed_msg_count)
 * - Time gate: elapsed >= 24h since most recent non-empty dreamed_at (or no prior dream history)
 * Never creates memory.db or writes any state.
 */
export function evaluateDreamReminder({
  dbPath = null,
  now = new Date(),
  minSessions = DREAM_MIN_UNSYNTHESIZED_SESSIONS,
  minIntervalHours = DREAM_MIN_INTERVAL_HOURS,
  nodeVersion = process.versions.node,
} = {}) {
  const emptyResult = {
    shouldRemind: false,
    unsynthesizedCount: 0,
    lastDreamedAt: null,
    hoursSinceLastDream: null,
    countGateMet: false,
    timeGateMet: true,
    reminderLine: "",
  };

  if (!supportsSqliteReadOnly(nodeVersion)) {
    return emptyResult;
  }

  const resolvedDbPath = resolveDbPath(dbPath);
  if (!fs.existsSync(resolvedDbPath)) {
    return emptyResult;
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) {
    return emptyResult;
  }

  let db;
  try {
    db = openSqliteDatabase(resolvedDbPath, { readOnly: true, timeout: 3000 });

    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
      .get();
    if (!tableRow) {
      return emptyResult;
    }

    const colRows = db.prepare("PRAGMA table_info(conversations)").all();
    const cols = new Set(colRows.map((r) => r.name));

    let unsynthesizedCount = 0;
    let lastDreamedMs = null;
    let lastDreamedAt = null;

    if (cols.has("dreamed_at") && cols.has("dreamed_msg_count")) {
      const countRow = db
        .prepare(`
          SELECT COUNT(*) AS cnt
          FROM conversations
          WHERE ${PENDING_DREAM_SQL}
        `)
        .get();
      unsynthesizedCount = Number(countRow?.cnt || 0);

      const dreamedRows = db
        .prepare(`
          SELECT DISTINCT dreamed_at
          FROM conversations
          WHERE TRIM(COALESCE(dreamed_at, '')) != ''
        `)
        .all();

      for (const row of dreamedRows) {
        const tsStr = typeof row.dreamed_at === "string" ? row.dreamed_at.trim() : "";
        if (!tsStr) continue;
        const parsedMs = Date.parse(tsStr);
        if (Number.isFinite(parsedMs) && (lastDreamedMs === null || parsedMs > lastDreamedMs)) {
          lastDreamedMs = parsedMs;
          lastDreamedAt = tsStr;
        }
      }
    } else {
      const countRow = db
        .prepare("SELECT COUNT(*) AS cnt FROM conversations WHERE message_count > 0")
        .get();
      unsynthesizedCount = Number(countRow?.cnt || 0);
    }

    const minIntervalMs = minIntervalHours * 60 * 60 * 1000;
    const countGateMet = unsynthesizedCount >= minSessions;

    let hoursSinceLastDream = null;
    let timeGateMet = true;
    if (lastDreamedMs !== null) {
      const elapsedMs = nowMs - lastDreamedMs;
      hoursSinceLastDream = elapsedMs / (60 * 60 * 1000);
      timeGateMet = elapsedMs >= minIntervalMs;
    }

    const shouldRemind = countGateMet && timeGateMet;
    const reminderLine = shouldRemind
      ? `[Memdex] Reminder: ${unsynthesizedCount} unsynthesized session(s) since last consolidation — consider distilling key memories into L2 notes.`
      : "";

    return {
      shouldRemind,
      unsynthesizedCount,
      lastDreamedAt,
      hoursSinceLastDream,
      countGateMet,
      timeGateMet,
      reminderLine,
    };
  } catch (err) {
    // Stay completely quiet if the DB disappeared between existsSync and readOnly open.
    if (fs.existsSync(resolvedDbPath)) {
      logHookError(err);
    }
    return emptyResult;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors.
      }
    }
  }
}

/**
 * Assemble SessionStart injection text from scoped L2 MEMORY.md index(es) and optional
 * 1-line dual-threshold consolidation reminder while strictly enforcing <=150 lines & <=8192 UTF-8 bytes.
 */
export function buildSessionStartContext({
  workspace = "",
  notesDir = null,
  dbPath = null,
  now = new Date(),
  nodeVersion = process.versions.node,
  maxGlobalLines = GLOBAL_INDEX_MAX_LINES,
  maxProjectLines = PROJECT_INDEX_MAX_LINES,
  maxTotalLines = TOTAL_INDEX_MAX_LINES,
  maxTotalBytes = TOTAL_INDEX_MAX_BYTES,
} = {}) {
  const dream = evaluateDreamReminder({ dbPath, now, nodeVersion });

  if (!dream.shouldRemind) {
    const index = getMemoryIndex({
      workspace,
      notesDir,
      maxGlobalLines,
      maxProjectLines,
      maxTotalLines,
      maxTotalBytes,
    });
    return {
      text: index.text,
      empty: index.empty,
      lines: index.lines,
      bytes: index.bytes,
      index,
      dream,
    };
  }

  const reminderSuffix = `\n${dream.reminderLine}`;
  const reminderSuffixBytes = Buffer.byteLength(reminderSuffix, "utf8");
  const reservedTotalLines = Math.max(1, maxTotalLines - 1);
  const reservedTotalBytes = Math.max(1, maxTotalBytes - reminderSuffixBytes);

  const index = getMemoryIndex({
    workspace,
    notesDir,
    maxGlobalLines,
    maxProjectLines,
    maxTotalLines: reservedTotalLines,
    maxTotalBytes: reservedTotalBytes,
  });

  let text;
  if (index.empty) {
    text = dream.reminderLine;
  } else {
    text = `${index.text.trimEnd()}${reminderSuffix}`;
  }

  const lines = text ? text.split("\n").length : 0;
  const bytes = Buffer.byteLength(text, "utf8");

  return {
    text,
    empty: text.length === 0,
    lines,
    bytes,
    index,
    dream,
  };
}

/**
 * Format SessionStart context text into the exact host-specific JSON contract.
 * Always returns `{}` when context text is empty.
 */
export function formatSessionStartResponse(host, contextText) {
  if (!contextText || typeof contextText !== "string" || !contextText.trim()) {
    return {};
  }

  if (host === "antigravity") {
    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: contextText,
          },
        },
      ],
    };
  }

  if (host === "claude" || host === "codex") {
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: contextText,
      },
    };
  }

  if (host === "gemini") {
    return {
      hookSpecificOutput: {
        additionalContext: contextText,
      },
    };
  }

  if (host === "plain") {
    return {
      additionalContext: contextText,
    };
  }

  return {};
}

function readHookStdin(rawInput) {
  if (rawInput !== null && rawInput !== undefined) {
    return String(rawInput);
  }
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}

function parseHookPayload(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hook stdin payload must be a JSON object.");
  }
  return parsed;
}

/**
 * Execute SessionStart hook and return the response object (never throws).
 */
export function runSessionStartHook({
  host = DEFAULT_HOOK_HOST,
  workspace = "",
  rawInput = null,
  now = new Date(),
  notesDir = null,
  dbPath = null,
} = {}) {
  try {
    const normalizedHost = normalizeHookHost(host);
    if (!normalizedHost) {
      logHookError(new Error(`Unsupported SessionStart hook host: '${host}'`));
      return {};
    }

    const raw = readHookStdin(rawInput);
    const payload = parseHookPayload(raw);
    const extractedWs = extractHookWorkspace(normalizedHost, payload, workspace);
    if (normalizedHost === "antigravity" && disablesAutomaticAntigravityMemory(extractedWs)) {
      return {};
    }

    const ctx = buildSessionStartContext({
      workspace: extractedWs,
      notesDir,
      dbPath,
      now,
    });
    return formatSessionStartResponse(normalizedHost, ctx.text);
  } catch (err) {
    logHookError(err);
    return {};
  }
}

/**
 * Execute Stop hook and return the response object `{}` (never throws).
 * Antigravity, Claude Code, and Codex import the finished session incrementally;
 * Gemini CLI and plain hosts stay a quiet no-op (use `memdex sync` / `memdex ingest`).
 */
export function runStopHookAdapter({
  host = DEFAULT_HOOK_HOST,
  rawInput = null,
} = {}) {
  try {
    const normalizedHost = normalizeHookHost(host);
    if (!normalizedHost) {
      logHookError(new Error(`Unsupported Stop hook host: '${host}'`));
      return {};
    }

    // Read stdin cleanly even for non-Antigravity no-op hosts so upstream pipe writers don't get EPIPE.
    const raw = readHookStdin(rawInput);
    if (normalizedHost === "claude" || normalizedHost === "codex") {
      syncHostStopPayload(normalizedHost, parseHookPayload(raw));
      return {};
    }
    if (normalizedHost !== "antigravity") {
      return {};
    }

    const payload = parseHookPayload(raw);
    syncAntigravityStopPayload(payload);
  } catch (err) {
    logHookError(err);
  }
  return {};
}
