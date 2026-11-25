import { createHash } from "node:crypto";

import { absoluteWorkspace } from "./collectors/records.mjs";
import { computeStaleness } from "./db.mjs";
import { getMemoryIndex } from "./notes.mjs";
import { DEFAULT_WORKSPACE, GLOBAL_SLUG, normalizeWorkspace, resolveProjectScope, workspaceToSlug } from "./paths.mjs";

export const MAX_DREAM_CANDIDATES = 20;
export const MAX_DREAM_MESSAGES = 50;
export const PENDING_DREAM_SQL = "message_count > 0 AND (" +
  "TRIM(COALESCE(dreamed_at, '')) = '' OR message_count > COALESCE(dreamed_msg_count, 0))";
export const MAIN_CONVERSATION_SQL = "COALESCE(is_subsession, 0) = 0";

function dreamWorkspace(workspace) {
  if (workspace === "") return DEFAULT_WORKSPACE;
  const absolute = absoluteWorkspace(workspace);
  if (!absolute) throw new TypeError("Dream workspace must be an absolute path or omitted for global scope.");
  return normalizeWorkspace(absolute);
}

function resolveDreamScope(db, { workspace = "", project = "" } = {}, { requireMatch = false } = {}) {
  const rawWs = typeof workspace === "string" ? workspace.trim() : "";
  const rawProj = typeof project === "string" ? project.trim() : "";

  if (rawWs && rawProj) {
    const canonicalWs = dreamWorkspace(rawWs);
    const resolvedProj = resolveProjectScope(db, rawProj);
    const projScope = resolvedProj?.workspace || (resolvedProj?.workspaceSlug === GLOBAL_SLUG ? DEFAULT_WORKSPACE : null);
    if (!projScope || projScope !== canonicalWs) {
      throw new TypeError("Specify either workspace or project, not conflicting values.");
    }
    return canonicalWs;
  }

  if (rawWs) return dreamWorkspace(rawWs);

  if (rawProj) {
    const resolved = resolveProjectScope(db, rawProj);
    if (!resolved) {
      if (requireMatch) {
        throw new TypeError(`Project '${rawProj}' did not match a single workspace. Pass an absolute workspace path or full project slug.`);
      }
      return null;
    }
    if (resolved.workspace) return resolved.workspace;
    if (resolved.workspaceSlug === GLOBAL_SLUG) return DEFAULT_WORKSPACE;
    if (requireMatch) {
      throw new TypeError(`Project '${rawProj}' has no concrete workspace path.`);
    }
    return null;
  }

  return DEFAULT_WORKSPACE;
}

function reviewedCount(row) {
  return row.dreamed_at?.trim() ? Math.max(0, row.dreamed_msg_count ?? 0) : 0;
}

function readWindow(db) {
  return db.prepare(
    "SELECT step_index, role, content, timestamp FROM messages WHERE conversation_id = ? " +
    "ORDER BY step_index ASC, id ASC LIMIT ? OFFSET ?"
  );
}

function snapshotHash(row, start, messages) {
  const content = messages.map(({ step_index, role, content, timestamp }) => [step_index, role, content, timestamp]);
  return createHash("sha256")
    .update(JSON.stringify([row.id, row.source, row.workspace, start, content]))
    .digest("hex");
}

export function getDreamCandidates(
  db,
  { workspace = "", project = "", source = "", limit = 5, maxMessages = 20, includeSubsessions = false } = {}
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DREAM_CANDIDATES ||
      !Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_DREAM_MESSAGES) {
    throw new RangeError("Invalid Dream candidate or message limit.");
  }
  const scope = resolveDreamScope(db, { workspace, project });
  if (scope === null) {
    return { workspace: "", total_pending: 0, hidden_subsessions: 0, candidates: [] };
  }
  const sourceFilter = source.trim();
  const includeSubFlag = includeSubsessions ? 1 : 0;

  db.exec("BEGIN");
  try {
    const totalPending = Number(
      db.prepare(
        "SELECT COUNT(*) AS cnt FROM conversations WHERE workspace = ? AND (? = '' OR source = ?) AND " +
        PENDING_DREAM_SQL + " AND (? = 1 OR " + MAIN_CONVERSATION_SQL + ")"
      ).get(scope, sourceFilter, sourceFilter, includeSubFlag)?.cnt || 0
    );
    const hiddenSubsessions = includeSubsessions
      ? 0
      : Number(
          db.prepare(
            "SELECT COUNT(*) AS cnt FROM conversations WHERE workspace = ? AND (? = '' OR source = ?) AND " +
            PENDING_DREAM_SQL + " AND COALESCE(is_subsession, 0) = 1"
          ).get(scope, sourceFilter, sourceFilter)?.cnt || 0
        );

    const rows = db.prepare(
      "SELECT id, source, workspace, last_updated, message_count, dreamed_at, dreamed_msg_count, COALESCE(is_subsession, 0) AS is_subsession " +
      "FROM conversations WHERE workspace = ? AND (? = '' OR source = ?) AND " + PENDING_DREAM_SQL +
      " AND (? = 1 OR " + MAIN_CONVERSATION_SQL + ")" +
      " ORDER BY last_updated DESC, id ASC LIMIT ?"
    ).all(scope, sourceFilter, sourceFilter, includeSubFlag, limit);
    const window = readWindow(db);
    const candidates = [];

    for (const row of rows) {
      const start = reviewedCount(row);
      const messages = window.all(row.id, Math.min(maxMessages, row.message_count - start), start);
      if (messages.length === 0) continue;
      candidates.push({
        conversation_id: row.id,
        source: row.source,
        workspace: row.workspace,
        last_updated: row.last_updated,
        message_count: row.message_count,
        is_subsession: Boolean(row.is_subsession),
        messages,
        receipt: {
          conversation_id: row.id,
          from_message_count: start,
          through_message_count: start + messages.length,
          snapshot_hash: snapshotHash(row, start, messages),
        },
      });
    }
    db.exec("COMMIT");
    return {
      workspace: scope === DEFAULT_WORKSPACE ? "" : scope,
      total_pending: totalPending,
      hidden_subsessions: hiddenSubsessions,
      candidates,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function validateReceipt(receipt) {
  const { conversation_id: id, from_message_count: start, through_message_count: end, snapshot_hash: hash } = receipt ?? {};
  if (typeof id !== "string" || !id.trim() || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end <= start || end - start > MAX_DREAM_MESSAGES ||
      typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new TypeError("Invalid Dream receipt. Use the complete receipt returned with a candidate.");
  }
}

function markReceipt(row, receipt, window, setWatermark, nowMs) {
  const { conversation_id, from_message_count: start, through_message_count: end, snapshot_hash: hash } = receipt;
  if (!row) return { conversation_id, status: "not_found" };
  const previous = reviewedCount(row);
  if (start > previous || end > row.message_count) return { conversation_id, status: "stale" };
  if (end <= previous) {
    return {
      conversation_id, status: "already_marked", dreamed_message_count: previous,
      pending_message_count: Math.max(0, row.message_count - previous),
    };
  }

  const messages = window.all(row.id, end - start, start);
  if (messages.length !== end - start || snapshotHash(row, start, messages) !== hash) {
    return { conversation_id, status: "stale" };
  }
  const previousTime = Date.parse(row.dreamed_at);
  const markedAt = new Date(Number.isFinite(previousTime) ? Math.max(previousTime, nowMs) : nowMs).toISOString();
  setWatermark.run(markedAt, end, row.id);
  return {
    conversation_id, status: "marked", dreamed_message_count: end, pending_message_count: row.message_count - end,
  };
}

/**
 * List every L2 note in one exact scope for a Dream note review, oldest first.
 * `in_index` reports whether the SessionStart index for that scope still shows the note.
 */
export function listScopeNotes(db, { workspace = "", notesDir = null, now = new Date() } = {}) {
  const canonical = dreamWorkspace(workspace);
  const isProject = canonical !== DEFAULT_WORKSPACE;
  const scope = isProject ? "project" : "global";
  const rows = db.prepare(
    "SELECT id, type, name, description, sources, updated FROM notes " +
    "WHERE scope = ? AND workspace_slug = ? ORDER BY updated ASC, id ASC"
  ).all(scope, isProject ? workspaceToSlug(canonical) : GLOBAL_SLUG);
  const injected = getMemoryIndex({ workspace: isProject ? canonical : "", notesDir }).text;

  const notes = rows.map((row) => {
    const { ageDays, isStale } = computeStaleness(row.updated, { now });
    let sources = [];
    try {
      sources = JSON.parse(row.sources || "[]");
    } catch {
      sources = [];
    }
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      description: row.description,
      updated: row.updated,
      age_days: ageDays,
      stale: isStale,
      source_count: Array.isArray(sources) ? sources.length : 0,
      in_index: injected.includes("`" + row.id + "`"),
    };
  });
  return {
    scope,
    workspace: isProject ? canonical : "",
    total: notes.length,
    hidden: notes.filter((note) => !note.in_index).length,
    stale: notes.filter((note) => note.stale).length,
    notes,
  };
}

export function markDreamed(db, { workspace = "", project = "", receipts, now = new Date() } = {}) {
  const scope = resolveDreamScope(db, { workspace, project }, { requireMatch: true });
  if (!Array.isArray(receipts) || receipts.length < 1 || receipts.length > MAX_DREAM_CANDIDATES) {
    throw new RangeError("Submit between 1 and " + MAX_DREAM_CANDIDATES + " Dream receipts.");
  }
  for (const receipt of receipts) validateReceipt(receipt);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("Invalid Dream timestamp.");

  const find = db.prepare(
    "SELECT id, source, workspace, message_count, dreamed_at, dreamed_msg_count FROM conversations WHERE id = ? AND workspace = ?"
  );
  const window = readWindow(db);
  const setWatermark = db.prepare("UPDATE conversations SET dreamed_at = ?, dreamed_msg_count = ? WHERE id = ?");

  db.exec("BEGIN IMMEDIATE");
  try {
    const results = receipts.map((receipt) =>
      markReceipt(find.get(receipt.conversation_id, scope), receipt, window, setWatermark, nowMs)
    );
    db.exec("COMMIT");
    return { results };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
