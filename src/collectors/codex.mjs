import path from "node:path";
import process from "node:process";

import { DEFAULT_WORKSPACE, expandHome } from "../paths.mjs";
import { directoryEntries, readTranscript, transcriptRoots, transcriptSnapshot } from "./files.mjs";
import { absoluteWorkspace, UUID } from "./records.mjs";
const ROLLOUT_NAME = /^rollout-.*\.jsonl$/;
const GENERATED_USER_TEXT = /^(?:# AGENTS\.md instructions\b|<(?:user_instructions|environment_context)\b)/i;

function codexRoots() {
  if (process.env.MEMDEX_CODEX_DIRS !== undefined) return transcriptRoots(process.env.MEMDEX_CODEX_DIRS);
  const codexHome = path.resolve(expandHome(process.env.CODEX_HOME?.trim() || "~/.codex"));
  return ["sessions", "archived_sessions"].map((dir) => path.join(codexHome, dir));
}

/**
 * Resolve a Stop hook `transcript_path` to a rollout snapshot inside a configured Codex root.
 */
export function locateCodexRollout(transcriptPath) {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) return null;
  const file = path.resolve(transcriptPath);
  if (!ROLLOUT_NAME.test(path.basename(file))) return null;
  const inside = codexRoots().some((root) => {
    const relative = path.relative(root, file);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  return inside ? transcriptSnapshot(file) : null;
}

export function discoverCodexRollouts() {
  const directories = codexRoots();
  const visited = new Set();
  const files = new Map();

  while (directories.length > 0) {
    const dir = directories.pop();
    if (visited.has(dir)) continue;
    visited.add(dir);

    for (const entry of directoryEntries(dir)) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        directories.push(filename);
      } else if (entry.isFile() && ROLLOUT_NAME.test(entry.name)) {
        const snapshot = transcriptSnapshot(filename);
        if (snapshot) files.set(filename, snapshot);
      }
    }
  }

  return [...files.values()];
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
  const raw = readTranscript(rollout);
  if (raw === null) return null;

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
