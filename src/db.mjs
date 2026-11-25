/**
 * Memdex SQLite database initialization, idempotent v2 -> v3 schema migration,
 * and freshness/staleness helpers.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_WORKSPACE,
  GLOBAL_SLUG,
  LEGACY_DB_PATH,
  migrateLegacyDbIfNeeded,
  normalizeWorkspace,
  resolveDbPath,
  workspaceToSlug,
} from "./paths.mjs";
import { PRIVATE_MARKER, redactSecrets } from "./redact.mjs";

export const SCHEMA_VERSION = 5;
export const DEFAULT_SOURCE = "antigravity";
export const STALE_WARNING_DAYS = 14;
export const STALE_STRONG_WARNING_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/**
 * SQLite supports readOnly from Node 22.12 and 23.2 in their respective release lines.
 */
export function supportsSqliteReadOnly(nodeVersion = process.versions.node) {
  const match = /^(\d+)\.(\d+)/.exec(String(nodeVersion || "").trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 22) return minor >= 12;
  if (major === 23) return minor >= 2;
  return major > 23;
}

/**
 * Compute age and staleness guidance for a memory/conversation timestamp.
 */
export function computeStaleness(timestamp, { now = new Date(), staleDays = STALE_WARNING_DAYS } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const tsMs = typeof timestamp === "string" && timestamp.trim() ? Date.parse(timestamp) : Number.NaN;

  if (!Number.isFinite(nowMs) || !Number.isFinite(tsMs)) {
    return {
      ageDays: null,
      ageLabel: "unknown age",
      isStale: false,
      stalenessNote: "",
    };
  }

  const diffMs = Math.max(0, nowMs - tsMs);
  const ageDays = Math.floor(diffMs / MS_PER_DAY);
  const ageLabel = ageDays === 0 ? "today" : `${ageDays}d ago`;
  const isStale = ageDays >= staleDays;

  let stalenessNote = "";
  if (ageDays >= STALE_STRONG_WARNING_DAYS) {
    stalenessNote = `Memory is ${ageDays}d old — verify claims against current code/git before relying on them.`;
  } else if (ageDays >= staleDays) {
    stalenessNote = `Memory is ${ageDays}d old — verify whether project state or code has changed.`;
  }

  return { ageDays, ageLabel, isStale, stalenessNote };
}

function getColumnNames(db, tableName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set(rows.map((r) => r.name));
}

function migrateConversationsToV3(db, prevVersion) {
  const cols = getColumnNames(db, "conversations");

  if (!cols.has("source")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT '${DEFAULT_SOURCE}';`);
  }
  if (!cols.has("workspace_slug")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN workspace_slug TEXT NOT NULL DEFAULT '${GLOBAL_SLUG}';`);
  }
  if (!cols.has("dreamed_at")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN dreamed_at TEXT NOT NULL DEFAULT '';`);
  }
  if (!cols.has("dreamed_msg_count")) {
    db.exec(`ALTER TABLE conversations ADD COLUMN dreamed_msg_count INTEGER NOT NULL DEFAULT 0;`);
  }

  // Normalize existing workspace paths & populate workspace_slug for migrated rows.
  const rows = db
    .prepare("SELECT id, workspace, workspace_slug FROM conversations")
    .all();

  if (rows.length > 0) {
    const updateWs = db.prepare(
      "UPDATE conversations SET workspace = ?, workspace_slug = ? WHERE id = ?"
    );
    const resetGlobalMtime = db.prepare(
      "UPDATE conversations SET file_mtime = 0 WHERE id = ?"
    );

    db.exec("BEGIN");
    try {
      for (const row of rows) {
        const canonical = normalizeWorkspace(row.workspace);
        const slug = workspaceToSlug(canonical);
        if (canonical !== row.workspace || slug !== row.workspace_slug) {
          updateWs.run(canonical, slug, row.id);
        }
        // On one-time upgrade from v1/v2 -> v3, reset mtime for legacy Global rows
        // so the next sync can backfill workspace from structured tool_calls.
        if (prevVersion > 0 && prevVersion < 3 && canonical === DEFAULT_WORKSPACE) {
          resetGlobalMtime.run(row.id);
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/**
 * One-time v5 upgrade: apply the L3 privacy filters to conversations stored before they existed.
 * Removes conversations marked private and redacts secrets in place; FTS triggers keep the index in sync.
 */
export function redactStoredConversations(db) {
  const findPrivate = db.prepare(
    "SELECT DISTINCT conversation_id AS id FROM messages WHERE UPPER(role) = 'USER' AND " +
    "LOWER(LTRIM(content, ' ' || char(9, 10, 13))) LIKE ? ESCAPE '\\'"
  );
  const deleteMessages = db.prepare("DELETE FROM messages WHERE conversation_id = ?");
  const deleteConversation = db.prepare("DELETE FROM conversations WHERE id = ?");
  const updateContent = db.prepare("UPDATE messages SET content = ? WHERE id = ?");

  db.exec("BEGIN IMMEDIATE");
  try {
    const privateIds = findPrivate.all(PRIVATE_MARKER.replace(/[\\%_]/g, "\\$&") + "%").map((row) => row.id);
    for (const id of privateIds) {
      deleteMessages.run(id);
      deleteConversation.run(id);
    }
    let redactedMessages = 0;
    const changed = [];
    for (const row of db.prepare("SELECT id, content FROM messages").iterate()) {
      const redacted = redactSecrets(row.content);
      if (redacted !== row.content) changed.push([redacted, row.id]);
    }
    for (const [content, id] of changed) {
      updateContent.run(content, id);
      redactedMessages += 1;
    }
    db.exec("COMMIT");
    return { privateConversations: privateIds.length, redactedMessages };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function initDb(dbPath = null, { legacyDbPath = null, autoMigrate = true } = {}) {
  const resolved = resolveDbPath(dbPath);
  const usingDefaultGlobalDb =
    !dbPath &&
    !(process.env.MEMDEX_DB && process.env.MEMDEX_DB.trim()) &&
    !(process.env.MEMDEX_HOME && process.env.MEMDEX_HOME.trim());

  const effectiveLegacy = legacyDbPath || (usingDefaultGlobalDb ? LEGACY_DB_PATH : null);
  if (autoMigrate && effectiveLegacy) {
    migrateLegacyDbIfNeeded(resolved, effectiveLegacy);
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const db = new DatabaseSync(resolved, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);

  const prevVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version || 0);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT '${DEFAULT_SOURCE}',
      workspace TEXT NOT NULL,
      workspace_slug TEXT NOT NULL DEFAULT '${GLOBAL_SLUG}',
      last_updated TEXT NOT NULL,
      source_path TEXT NOT NULL DEFAULT '',
      file_mtime REAL NOT NULL DEFAULT 0,
      file_size INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      dreamed_at TEXT NOT NULL DEFAULT '',
      dreamed_msg_count INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS notes (
      rowid_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      workspace TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE}',
      workspace_slug TEXT NOT NULL DEFAULT '${GLOBAL_SLUG}',
      slug TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      sources TEXT NOT NULL DEFAULT '[]',
      updated TEXT NOT NULL,
      file_path TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notes_scope_ws_updated
      ON notes (scope, workspace_slug, updated DESC);
    CREATE INDEX IF NOT EXISTS idx_notes_type
      ON notes (type);

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      note_id UNINDEXED,
      name,
      description,
      content,
      content='notes',
      content_rowid='rowid_id',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, note_id, name, description, content)
      VALUES (new.rowid_id, new.id, new.name, new.description, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, note_id, name, description, content)
      VALUES ('delete', old.rowid_id, old.id, old.name, old.description, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, note_id, name, description, content)
      VALUES ('delete', old.rowid_id, old.id, old.name, old.description, old.content);
      INSERT INTO notes_fts(rowid, note_id, name, description, content)
      VALUES (new.rowid_id, new.id, new.name, new.description, new.content);
    END;
  `);

  migrateConversationsToV3(db, prevVersion);
  if (prevVersion > 0 && prevVersion < 5) redactStoredConversations(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_source
      ON conversations (source);
    CREATE INDEX IF NOT EXISTS idx_conversations_ws_slug
      ON conversations (workspace_slug);
    CREATE INDEX IF NOT EXISTS idx_conversations_dream
      ON conversations (dreamed_at, last_updated DESC);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);

  return db;
}
