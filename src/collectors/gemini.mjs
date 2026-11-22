import path from "node:path";
import process from "node:process";

import { DEFAULT_WORKSPACE, expandHome } from "../paths.mjs";
import { directoryEntries, readTranscript, transcriptRoots, transcriptSnapshot } from "./files.mjs";
import { absoluteWorkspace, jsonlEntries, toConversation } from "./records.mjs";

const SESSION_NAME = /^session-.+\.jsonl?$/;
const SESSION_ID = /^[a-z0-9_-]{1,128}$/i;
const GENERATED_PROMPT = /^<(?:session_context|hook_context)>/i;

export function discoverGeminiSessions() {
  const home = expandHome(process.env.GEMINI_CLI_HOME?.trim() || "~");
  const roots = transcriptRoots(process.env.MEMDEX_GEMINI_DIRS, path.join(home, ".gemini", "tmp"));
  const files = [];
  for (const root of roots) {
    for (const project of directoryEntries(root)) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(root, project.name);
      const chats = directoryEntries(path.join(projectDir, "chats"));
      if (chats.length === 0) continue;
      const marker = transcriptSnapshot(path.join(projectDir, ".project_root"));
      const workspaceHint = marker && marker.fileSize <= 16_384
        ? absoluteWorkspace(readTranscript(marker)) || DEFAULT_WORKSPACE
        : DEFAULT_WORKSPACE;
      for (const entry of chats) {
        if (!entry.isFile() || !SESSION_NAME.test(entry.name)) continue;
        const file = transcriptSnapshot(path.join(projectDir, "chats", entry.name));
        if (file) files.push({ ...file, workspaceHint });
      }
    }
  }
  return files;
}

function readEntries(raw, filename) {
  if (filename.endsWith(".jsonl")) return jsonlEntries(raw);
  try {
    const snapshot = JSON.parse(raw);
    return snapshot && Array.isArray(snapshot.messages) ? [snapshot] : [];
  } catch {
    return [];
  }
}

function storeMessage(messages, record) {
  if (typeof record?.id === "string" && record.id) messages.set(record.id, record);
}

function applyPatch(messages, patch) {
  const updates = Array.isArray(patch.updates) ? [patch, ...patch.updates] : [patch];
  for (const update of updates) {
    const current = messages.get(update?.id);
    if (current && Object.hasOwn(update, "content")) {
      messages.set(update.id, { ...current, content: update.content });
    }
  }
  if (Array.isArray(patch.removeIds)) {
    for (const id of patch.removeIds) messages.delete(id);
  }
  if (Array.isArray(patch.orderIds)) {
    for (const id of new Set(patch.orderIds)) {
      const message = messages.get(id);
      if (!message) continue;
      messages.delete(id);
      messages.set(id, message);
    }
  }
}

function readTimeline(entries) {
  let sessionId;
  let kind;
  const messages = new Map();

  for (const entry of entries) {
    const rewind = entry.$rewindTo;
    if (typeof rewind === "string") {
      let remove = !messages.has(rewind);
      for (const id of messages.keys()) {
        remove ||= id === rewind;
        if (remove) messages.delete(id);
      }
    } else if (entry.$patch && typeof entry.$patch === "object") {
      applyPatch(messages, entry.$patch);
    } else if (typeof entry.id === "string") {
      storeMessage(messages, entry);
    } else {
      const change = entry.$set;
      const metadata = change && typeof change === "object" ? change : entry;
      if (typeof metadata.sessionId === "string" && typeof metadata.projectHash === "string") {
        if (sessionId && sessionId !== metadata.sessionId) return null;
        sessionId = metadata.sessionId;
      }
      kind = metadata.kind ?? kind;
      if (Array.isArray(metadata.messages)) {
        if (metadata === change) messages.clear();
        for (const message of metadata.messages) storeMessage(messages, message);
      }
    }
  }

  if (kind === "subagent" || typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  return { sessionId, messages };
}

function textOnly(content) {
  const parts = Array.isArray(content) ? content : [content];
  const text = [];
  for (const part of parts) {
    if (typeof part === "string") text.push(part);
    else if (!part?.thought && typeof part?.text === "string" && !part.functionCall && !part.functionResponse) {
      text.push(part.text);
    }
  }
  return text.filter((part) => part.trim()).join("\n").trim();
}

export function readGeminiSession(file) {
  const raw = readTranscript(file);
  if (raw === null) return null;
  const timeline = readTimeline(readEntries(raw, file.sourcePath));
  if (!timeline) return null;

  const messages = [];
  for (const entry of timeline.messages.values()) {
    if (entry.type !== "user" && entry.type !== "gemini") continue;
    const content = textOnly(entry.content);
    if (!content || (entry.type === "user" && GENERATED_PROMPT.test(content))) continue;
    messages.push({ role: entry.type === "user" ? "USER" : "AI", content, timestamp: entry.timestamp });
  }
  return toConversation(file, "gemini-cli", timeline.sessionId, file.workspaceHint, messages);
}
