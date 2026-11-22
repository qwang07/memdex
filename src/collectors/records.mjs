import path from "node:path";

import { DEFAULT_WORKSPACE } from "../paths.mjs";

export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function absoluteWorkspace(cwd) {
  if (typeof cwd !== "string" || cwd.includes("\0")) return "";
  const trimmed = cwd.trim();
  return path.isAbsolute(trimmed) || path.posix.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)
    ? trimmed
    : "";
}

export function* jsonlEntries(raw) {
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object" && !Array.isArray(entry)) yield entry;
    } catch {
      // A host can leave an unfinished last line while appending.
    }
  }
}

export function toConversation(file, source, sessionId, workspace, entries) {
  if (entries.length === 0) return null;
  let newest = -Infinity;
  const messages = entries.map(({ role, content, timestamp }, stepIndex) => {
    const time = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    if (Number.isFinite(time)) newest = Math.max(newest, time);
    return { role, content, stepIndex, timestamp: Number.isFinite(time) ? new Date(time).toISOString() : "" };
  });
  return {
    ...file,
    id: source + ":" + sessionId,
    source,
    workspace: workspace || DEFAULT_WORKSPACE,
    lastUpdated: new Date(Number.isFinite(newest) ? newest : file.fileMtime).toISOString(),
    messages,
  };
}
