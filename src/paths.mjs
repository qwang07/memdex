/**
 * Memdex path resolution, legacy database migration, and cross-tool workspace normalization.
 * Pure Node.js built-ins only (zero external dependencies).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PLUGIN_ROOT = path.resolve(__dirname, "..");
export const LEGACY_DB_PATH = path.join(PLUGIN_ROOT, "data", "memory.db");
export const DEFAULT_WORKSPACE = "Global / No Workspace";
export const GLOBAL_SLUG = "global";

const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;

export function expandHome(filePath) {
  if (!filePath || typeof filePath !== "string") return "";
  const trimmed = filePath.trim();
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(home, trimmed.slice(2));
  }
  return trimmed;
}

export function resolveMemdexHome() {
  if (process.env.MEMDEX_HOME && process.env.MEMDEX_HOME.trim()) {
    return path.resolve(expandHome(process.env.MEMDEX_HOME));
  }
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".memdex");
}

export function resolveDbPath(explicitPath = null) {
  if (explicitPath && typeof explicitPath === "string" && explicitPath.trim()) {
    return path.resolve(expandHome(explicitPath));
  }
  if (process.env.MEMDEX_DB && process.env.MEMDEX_DB.trim()) {
    return path.resolve(expandHome(process.env.MEMDEX_DB));
  }
  return path.join(resolveMemdexHome(), "memory.db");
}

export function resolveNotesDir(explicitNotesDir = null) {
  if (explicitNotesDir && typeof explicitNotesDir === "string" && explicitNotesDir.trim()) {
    return path.resolve(expandHome(explicitNotesDir));
  }
  if (process.env.MEMDEX_NOTES_DIR && process.env.MEMDEX_NOTES_DIR.trim()) {
    return path.resolve(expandHome(process.env.MEMDEX_NOTES_DIR));
  }
  if (process.env.MEMDEX_HOME && process.env.MEMDEX_HOME.trim()) {
    return path.join(resolveMemdexHome(), "notes");
  }
  if (process.env.MEMDEX_DB && process.env.MEMDEX_DB.trim()) {
    return path.join(path.dirname(resolveDbPath()), "notes");
  }
  return path.join(resolveMemdexHome(), "notes");
}

export function resolveHookLogPath() {
  if (process.env.MEMDEX_HOME && process.env.MEMDEX_HOME.trim()) {
    return path.join(resolveMemdexHome(), "hook.log");
  }
  if (process.env.MEMDEX_DB && process.env.MEMDEX_DB.trim()) {
    return path.join(path.dirname(resolveDbPath()), "hook.log");
  }
  return path.join(resolveMemdexHome(), "hook.log");
}

function stripTrailingSlashes(p) {
  if (!p) return "";
  if (WINDOWS_ABS_RE.test(p)) {
    const root = `${p.slice(0, 2)}\\`;
    const rest = p.slice(3).replace(/[\\/]+$/, "");
    return rest ? `${root}${rest.replace(/\//g, "\\")}` : root;
  }
  if (p === "/") return "/";
  return p.replace(/\/+$/, "") || "/";
}

/**
 * Normalize a workspace path consistently across tools (Antigravity, Claude Code, Codex, Gemini, Retinue).
 * Resolves symlinks via realpath when the path exists on disk so symlinked repos share one identity.
 */
export function normalizeWorkspace(workspacePath) {
  if (!workspacePath || typeof workspacePath !== "string") {
    return DEFAULT_WORKSPACE;
  }
  const trimmed = workspacePath.trim();
  if (!trimmed || trimmed === DEFAULT_WORKSPACE) {
    return DEFAULT_WORKSPACE;
  }

  if (WINDOWS_ABS_RE.test(trimmed)) {
    const normalized = stripTrailingSlashes(trimmed);
    return normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
  }

  const expanded = expandHome(trimmed);
  let resolved = path.resolve(expanded);
  try {
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      const dirPath = stat.isFile() ? path.dirname(resolved) : resolved;
      resolved = fs.realpathSync.native ? fs.realpathSync.native(dirPath) : fs.realpathSync(dirPath);
    }
  } catch {
    // Keep path.resolve fallback if unreadable or permission-denied.
  }

  return stripTrailingSlashes(resolved);
}

export function disablesAutomaticAntigravityMemory(workspacePath) {
  const workspace = normalizeWorkspace(workspacePath);
  return workspace !== DEFAULT_WORKSPACE && fs.existsSync(path.join(workspace, ".agents", "memdex-readonly"));
}

/**
 * Derive a deterministic, collision-free, human-readable directory slug for a workspace.
 * Example: "/Users/dev/Projects/memdex" -> "memdex-a1b2c3d4"
 */
export function workspaceToSlug(workspacePath) {
  const canonical = normalizeWorkspace(workspacePath);
  if (!canonical || canonical === DEFAULT_WORKSPACE) {
    return GLOBAL_SLUG;
  }

  const base = WINDOWS_ABS_RE.test(canonical)
    ? path.win32.basename(canonical)
    : path.posix.basename(canonical);

  const safeBase =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "project";

  const hashInput = WINDOWS_ABS_RE.test(canonical) ? canonical.toLowerCase() : canonical;
  const shortHash = crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
  return `${safeBase}-${shortHash}`;
}


/**
 * Resolve a project selector to one workspace identity. An empty object means unfiltered.
 * A missing or ambiguous explicit selector resolves to null.
 */
export function resolveProjectScope(db, project) {
  if (project == null || project === "") return {};
  if (typeof project !== "string" || !project.trim() || project.includes("\0")) return null;

  const selector = project.trim();
  const expanded = expandHome(selector);
  if (selector === DEFAULT_WORKSPACE) return { workspaceSlug: GLOBAL_SLUG };
  if (path.isAbsolute(expanded) || WINDOWS_ABS_RE.test(expanded)) {
    return { workspace: normalizeWorkspace(expanded) };
  }
  if (selector.includes("/") || selector.includes("\\")) return null;

  const suffix = "/" + selector;
  // Check concrete workspaces first so two matches still signal ambiguity.
  const [first, second] = db.prepare(`
    SELECT workspace,
      MAX(CASE WHEN workspace_slug = ? COLLATE NOCASE THEN workspace_slug END) AS matchedSlug
    FROM (
      SELECT workspace, workspace_slug FROM conversations
      UNION ALL
      SELECT workspace, workspace_slug FROM notes
    )
    WHERE workspace_slug = ? COLLATE NOCASE
       OR substr(replace(workspace, char(92), '/'), -length(?)) = ? COLLATE NOCASE
    GROUP BY workspace
    ORDER BY workspace = ?
    LIMIT 2
  `).all(selector, selector, suffix, suffix, DEFAULT_WORKSPACE);

  if (!first) return null;
  if (first.workspace === DEFAULT_WORKSPACE) return { workspaceSlug: first.matchedSlug };
  if (!second) return { workspace: first.workspace };
  if (second.workspace === DEFAULT_WORKSPACE && first.matchedSlug && selector.toLowerCase() !== GLOBAL_SLUG) {
    return { workspace: first.workspace, workspaceSlug: first.matchedSlug };
  }
  return null;
}

export function appendProjectScope(where, params, { workspace, workspaceSlug }, columnPrefix = "") {
  const workspaceColumn = columnPrefix + "workspace";
  if (workspaceSlug) {
    // Legacy project notes use the placeholder workspace and keep their slug.
    const slugFilter = `(${workspaceColumn} = ? AND ${columnPrefix}workspace_slug = ? COLLATE NOCASE)`;
    if (workspace) {
      where.push(`(${workspaceColumn} = ? OR ${slugFilter})`);
      params.push(workspace, DEFAULT_WORKSPACE, workspaceSlug);
    } else {
      where.push(slugFilter);
      params.push(DEFAULT_WORKSPACE, workspaceSlug);
    }
  } else if (workspace) {
    where.push(workspaceColumn + " = ?");
    params.push(workspace);
  }
}

/**
 * Safely migrate legacy `<plugin>/data/memory.db` into `<memdexHome>/memory.db` if the target does not exist.
 * Non-destructive: uses SQLite `VACUUM INTO` to flush any pending WAL frames into a clean copy
 * while leaving the legacy file untouched as a backup.
 */
export function migrateLegacyDbIfNeeded(targetDbPath, legacyDbPath = LEGACY_DB_PATH) {
  if (!targetDbPath || !legacyDbPath) {
    return { migrated: false, reason: "no-path" };
  }

  const resolvedTarget = path.resolve(expandHome(targetDbPath));
  const resolvedLegacy = path.resolve(expandHome(legacyDbPath));

  if (resolvedTarget === resolvedLegacy) {
    return { migrated: false, reason: "same-path" };
  }
  if (fs.existsSync(resolvedTarget)) {
    return { migrated: false, reason: "target-exists" };
  }
  if (!fs.existsSync(resolvedLegacy)) {
    return { migrated: false, reason: "legacy-missing" };
  }

  let stat;
  try {
    stat = fs.statSync(resolvedLegacy);
  } catch {
    return { migrated: false, reason: "legacy-unreadable" };
  }
  if (!stat.isFile() || stat.size === 0) {
    return { migrated: false, reason: "legacy-empty" };
  }

  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
  const tmpTarget = `${resolvedTarget}.migrating-${process.pid}-${Date.now()}`;

  try {
    const srcDb = new DatabaseSync(resolvedLegacy, { timeout: 5000 });
    try {
      const escaped = tmpTarget.replace(/'/g, "''");
      srcDb.exec(`VACUUM INTO '${escaped}'`);
    } finally {
      srcDb.close();
    }
    fs.renameSync(tmpTarget, resolvedTarget);
    return { migrated: true, method: "vacuum-into", from: resolvedLegacy, to: resolvedTarget };
  } catch {
    try {
      if (fs.existsSync(tmpTarget)) fs.rmSync(tmpTarget, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
    // Fallback to raw file copy (+ sidecars if present).
    fs.copyFileSync(resolvedLegacy, tmpTarget);
    fs.renameSync(tmpTarget, resolvedTarget);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${resolvedLegacy}${suffix}`;
      if (fs.existsSync(sidecar)) {
        fs.copyFileSync(sidecar, `${resolvedTarget}${suffix}`);
      }
    }
    return { migrated: true, method: "file-copy", from: resolvedLegacy, to: resolvedTarget };
  }
}
