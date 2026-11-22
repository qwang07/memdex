import path from "node:path";
import process from "node:process";

import { expandHome } from "../paths.mjs";
import { directoryEntries, readTranscript, transcriptRoots, transcriptSnapshot } from "./files.mjs";
import { absoluteWorkspace, toConversation, jsonlEntries, UUID } from "./records.mjs";

const TRANSCRIPT_TYPES = new Set(["user", "assistant", "system", "attachment", "progress"]);
const GENERATED_PROMPT = /^(?:<(?:local-command-(?:stdout|stderr|caveat)|session-start-hook|command-(?:name|message)|system-reminder|ide_opened_file|ide_selection|tick|goal)\b|\[Request interrupted by user)/i;

export function discoverClaudeSessions() {
  const home = expandHome(process.env.CLAUDE_CONFIG_DIR?.trim() || "~/.claude");
  const roots = transcriptRoots(process.env.MEMDEX_CLAUDE_DIRS, path.join(home, "projects"));
  const files = [];
  for (const root of roots) {
    for (const project of directoryEntries(root)) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(root, project.name);
      for (const entry of directoryEntries(projectDir)) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const sessionId = entry.name.slice(0, -6).toLowerCase();
        if (!UUID.test(sessionId)) continue;
        const file = transcriptSnapshot(path.join(projectDir, entry.name));
        if (file) files.push({ ...file, sessionId });
      }
    }
  }
  return files;
}

function isMainMessage(entry) {
  return (entry.type === "user" || entry.type === "assistant") &&
    !entry.isSidechain && !entry.isMeta && !entry.isCompactSummary && !entry.teamName;
}

function mainChain(entries) {
  const last = entries.findLast(isMainMessage);
  if (!last) return [];
  if (typeof last.uuid !== "string" || !Object.hasOwn(last, "parentUuid")) return entries;

  const byId = new Map(entries.filter((entry) => typeof entry.uuid === "string").map((entry) => [entry.uuid, entry]));
  const chain = [];
  const seen = new Set();
  let entry = last;
  while (entry && !seen.has(entry.uuid)) {
    seen.add(entry.uuid);
    chain.push(entry);
    entry = byId.get(entry.parentUuid);
  }
  return chain.reverse();
}

function visibleText(message, isUser) {
  const content = message?.content;
  const parts = typeof content === "string" ? [content] :
    Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => part.text) : [];
  return parts.filter((text) =>
    typeof text === "string" && text.trim() && (!isUser || !GENERATED_PROMPT.test(text.trimStart()))
  ).join("\n").trim();
}

export function readClaudeSession(file) {
  const raw = readTranscript(file);
  if (raw === null) return null;
  const entries = [...jsonlEntries(raw)].filter((entry) =>
    TRANSCRIPT_TYPES.has(entry.type) &&
    (entry.sessionId == null || (typeof entry.sessionId === "string" && entry.sessionId.toLowerCase() === file.sessionId))
  );
  const seenIds = new Set();
  const messages = [];
  let workspace = "";
  for (const entry of mainChain(entries)) {
    if (!isMainMessage(entry) || entry.message?.role !== entry.type) continue;
    workspace ||= absoluteWorkspace(entry.cwd);
    const isUser = entry.type === "user";
    const content = visibleText(entry.message, isUser);
    if (!content || seenIds.has(entry.uuid)) continue;
    if (typeof entry.uuid === "string") seenIds.add(entry.uuid);
    messages.push({ role: isUser ? "USER" : "AI", content, timestamp: entry.timestamp });
  }
  return messages.length ? toConversation(file, "claude-code", file.sessionId, workspace, messages) : null;
}
