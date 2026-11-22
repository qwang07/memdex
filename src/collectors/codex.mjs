import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { DEFAULT_WORKSPACE, expandHome } from "../paths.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ROLLOUT_NAME = /^rollout-.*\.jsonl$/;
const GENERATED_USER_TEXT = /^(?:# AGENTS\.md instructions\b|<(?:user_instructions|environment_context)\b)/i;

function codexRoots() {
  const override = process.env.MEMDEX_CODEX_DIRS;
  if (override !== undefined) {
    return override.split(path.delimiter)
      .map(expandHome)
      .filter(Boolean)
      .map((dir) => path.resolve(dir));
  }

  const codexHome = path.resolve(expandHome(process.env.CODEX_HOME?.trim() || "~/.codex"));
  return ["sessions", "archived_sessions"].map((dir) => path.join(codexHome, dir));
}

export function discoverCodexRollouts() {
  const directories = codexRoots();
  const visited = new Set();
  const files = new Map();

  while (directories.length > 0) {
    const dir = directories.pop();
    if (visited.has(dir)) continue;
    visited.add(dir);

    let entries;
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        directories.push(filename);
      } else if (entry.isFile() && ROLLOUT_NAME.test(entry.name)) {
        try {
          const stat = fs.lstatSync(filename);
          if (!stat.isFile()) continue;
          fs.accessSync(filename, fs.constants.R_OK);
          files.set(filename, { sourcePath: filename, fileMtime: stat.mtimeMs, fileSize: stat.size });
        } catch {
          // The host can remove or archive a rollout during discovery.
        }
      }
    }
  }

  return [...files.values()].sort((a, b) => {
    const byStat = b.fileMtime - a.fileMtime || b.fileSize - a.fileSize;
    if (byStat !== 0) return byStat;
    if (a.sourcePath < b.sourcePath) return -1;
    return Number(a.sourcePath > b.sourcePath);
  });
}

function absoluteWorkspace(cwd) {
  if (typeof cwd !== "string" || cwd.includes("\0")) return "";
  const trimmed = cwd.trim();
  return path.isAbsolute(trimmed) || path.posix.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)
    ? trimmed
    : "";
}

function messageText(payload, isUser) {
  if (!Array.isArray(payload.content)) return "";
  const blockType = isUser ? "input_text" : "output_text";
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const texts = [];
  for (const [index, block] of payload.content.entries()) {
    if (block?.type !== blockType || typeof block.text !== "string" || !block.text.trim()) continue;
    if (isUser) {
      const kind = Array.isArray(kinds) ? kinds[index] : undefined;
      if (kind != null ? kind !== "user.text" : GENERATED_USER_TEXT.test(block.text.trimStart())) continue;
    }
    texts.push(block.text);
  }
  return texts.join("\n").trim();
}

export function readCodexRollout(rollout) {
  let raw;
  try {
    raw = fs.readFileSync(rollout.sourcePath, "utf8");
    const stat = fs.lstatSync(rollout.sourcePath);
    if (!stat.isFile() || stat.mtimeMs !== rollout.fileMtime || stat.size !== rollout.fileSize) return null;
  } catch {
    return null;
  }

  let threadId = "";
  let sessionWorkspace = "";
  let turnWorkspace = "";
  let latestTime = -Infinity;
  const messages = [];

  for (const [stepIndex, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record?.payload;
    if (!payload) continue;

    if (record.type === "session_meta") {
      if (!threadId && typeof payload.id === "string" && UUID.test(payload.id)) {
        threadId = payload.id.toLowerCase();
      }
      sessionWorkspace ||= absoluteWorkspace(payload.cwd);
      continue;
    }
    if (record.type === "turn_context") {
      turnWorkspace ||= absoluteWorkspace(payload.cwd);
      continue;
    }
    if (record.type !== "response_item" || payload.type !== "message") continue;

    const isUser = payload.role === "user";
    const isFinalAnswer = payload.role === "assistant" && (payload.phase == null || payload.phase === "final_answer");
    if (!isUser && !isFinalAnswer) continue;
    const content = messageText(payload, isUser);
    if (!content) continue;

    const time = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    if (Number.isFinite(time)) latestTime = Math.max(latestTime, time);
    messages.push({
      stepIndex,
      role: isUser ? "USER" : "AI",
      content,
      timestamp: Number.isFinite(time) ? new Date(time).toISOString() : "",
    });
  }

  if (!threadId || messages.length === 0) return null;
  return {
    ...rollout,
    id: "codex:" + threadId,
    source: "codex",
    workspace: sessionWorkspace || turnWorkspace || DEFAULT_WORKSPACE,
    lastUpdated: new Date(Number.isFinite(latestTime) ? latestTime : rollout.fileMtime).toISOString(),
    messages,
  };
}
