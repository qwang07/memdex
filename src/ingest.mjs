import { initDb, upsertConversationRecord } from "../scripts/harness.mjs";
import { absoluteWorkspace, toConversation } from "./collectors/records.mjs";

const SOURCE = "retinue";
const SESSION_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export function ingestConversation(input, { dbPath } = {}) {
  if (typeof input?.id !== "string" || !SESSION_ID.test(input.id)) {
    throw new TypeError("Expected a Retinue session id of 1–128 letters, digits, dots, underscores, or hyphens.");
  }
  const workspace = absoluteWorkspace(input.workspace);
  if (input.workspace !== undefined && !workspace) {
    throw new TypeError("Expected an absolute workspace path or an omitted workspace.");
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new TypeError("Expected a non-empty messages array.");
  }

  const messages = Array.from(input.messages, (message, index) => {
    const role = message?.role;
    if (role !== "user" && role !== "assistant") {
      throw new TypeError("Message " + (index + 1) + " must have role user or assistant.");
    }
    if (typeof message.content !== "string" || !message.content.trim() ||
        typeof message.timestamp !== "string" || !Number.isFinite(Date.parse(message.timestamp))) {
      throw new TypeError("Message " + (index + 1) + " must have non-empty content and a valid timestamp.");
    }
    return { role: role === "user" ? "USER" : "AI", content: message.content, timestamp: message.timestamp };
  });
  const record = toConversation({}, SOURCE, input.id, workspace, messages);
  const db = initDb(dbPath);
  try {
    const status = upsertConversationRecord(db, record, { compareSnapshot: true });
    return { id: record.id, source: SOURCE, status };
  } finally {
    db.close();
  }
}
