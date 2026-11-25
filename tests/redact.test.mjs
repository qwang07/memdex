import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { initDb, SCHEMA_VERSION, searchMessages } from "../scripts/harness.mjs";
import { isPrivateConversation, PRIVATE_MARKER, redactSecrets } from "../src/redact.mjs";

const CLI = fileURLToPath(new URL("../bin/memdex.mjs", import.meta.url));

// Fake credentials are assembled at runtime so secret scanners do not flag this file.
const FAKE = {
  openai: "sk-" + "proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2",
  github: "ghp_" + "a1B2".repeat(9),
  aws: "AKIA" + "ABCDEFGH12345678",
  google: "AIza" + "S".repeat(20) + "y1234567890abcd",
  slack: "xoxb-" + "1234567890-abcdef",
  stripe: "sk_live_" + "a1B2c3D4e5F6g7H8",
  jwt: "eyJ" + "hbGciOiJIUzI1NiJ9" + ".eyJ" + "zdWIiOiIxMjM0In0" + "." + "c2lnbmF0dXJlLXZhbHVl",
  // A checksum-valid synthetic Chinese ID number and a Luhn-valid test card number.
  idNumber: "11010519491231002X",
  card: "4111 1111 1111 1111",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----",
};

test("redacts credentials, tokens, keys, ID numbers, and card numbers", () => {
  const cases = [
    [`key ${FAKE.openai} end`, "key [REDACTED:api_key] end"],
    [`push with ${FAKE.github}`, "push with [REDACTED:github_token]"],
    [`aws ${FAKE.aws}`, "aws [REDACTED:aws_key]"],
    [`google ${FAKE.google}`, "google [REDACTED:google_key]"],
    [`slack ${FAKE.slack}`, "slack [REDACTED:slack_token]"],
    [`stripe ${FAKE.stripe}`, "stripe [REDACTED:stripe_key]"],
    [`token：${FAKE.jwt}`, "token：[REDACTED:jwt]"],
    [`Authorization: Bearer abcdef1234567890XYZ`, "Authorization: Bearer [REDACTED:token]"],
    ["DATABASE_URL=postgresql://admin:s3cr3t-Pw@db:5432/app", "DATABASE_URL=postgresql://admin:[REDACTED:password]@db:5432/app"],
    ["PASSWORD=hunter2hunter2", "PASSWORD=[REDACTED:secret]"],
    ['"api_key": "abc123def456"', '"api_key": "[REDACTED:secret]"'],
    ["数据库密码：Abc12345", "数据库密码：[REDACTED:secret]"],
    [`身份证 ${FAKE.idNumber} 已登记`, "身份证 [REDACTED:id_number] 已登记"],
    [`卡号 ${FAKE.card}`, "卡号 [REDACTED:card_number]"],
    [`key:\n${FAKE.pem}\ndone`, "key:\n[REDACTED:private_key]\ndone"],
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
});

test("leaves ordinary code, identifiers, and prose unchanged", () => {
  const untouched = [
    "token: string; password: z.string()",
    "const apiKey = process.env.OPENAI_API_KEY;",
    "commit 275f15d6baca102efe9a5a39465f7bde90f6a929",
    "conversation c7b3ff1c-8690-4135-a264-ea1bd6dc6388",
    "timestamp 1764048000000 and 1764048000000123456",
    "抹掉服务器的密钥：逐行处理",
    "身份证号校验位错误 110105194912310021",
    "order 4111111111111112",
    "sed -E 's#postgresql://([^:]+):([^@]+)@#x#'",
    "postgresql://localhost:5432/app",
  ];
  for (const text of untouched) assert.equal(redactSecrets(text), text, text);
});

test("treats only a user message starting with the marker as a private conversation", () => {
  const user = (content) => ({ role: "USER", content });
  assert.equal(isPrivateConversation([user("hello"), user(`  ${PRIVATE_MARKER} please`)]), true);
  assert.equal(isPrivateConversation([user(PRIVATE_MARKER.toUpperCase())]), true);
  assert.equal(isPrivateConversation([user(`How does ${PRIVATE_MARKER} work?`)]), false);
  assert.equal(isPrivateConversation([{ role: "AI", content: PRIVATE_MARKER }]), false);
});

function isolatedEnv(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memdex-redact-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = (name) => {
    const result = path.join(root, name);
    fs.mkdirSync(result, { recursive: true });
    return result;
  };
  const memdexHome = dir("memory");
  const dbPath = path.join(memdexHome, "memory.db");
  return {
    root, dbPath,
    env: {
      ...process.env, HOME: dir("home"), MEMDEX_HOME: memdexHome, MEMDEX_DB: dbPath,
      MEMDEX_NOTES_DIR: path.join(memdexHome, "notes"), MEMDEX_BRAIN_DIRS: dir("brain"),
      CODEX_HOME: dir("codex"), CLAUDE_CONFIG_DIR: dir("claude"), MEMDEX_CODEX_DIRS: "", MEMDEX_CLAUDE_DIRS: "", MEMDEX_GEMINI_DIRS: "",
    },
  };
}

function ingest(env, id, contents) {
  const messages = contents.map((content, index) => ({
    role: index % 2 === 0 ? "user" : "assistant", content, timestamp: new Date(Date.UTC(2026, 10, 25, 0, 0, index)).toISOString(),
  }));
  const result = spawnSync(process.execPath, [CLI, "ingest", "--source", "retinue"], {
    encoding: "utf8", env, input: JSON.stringify({ id, messages }),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("stores redacted text and drops a conversation once it is marked private", (t) => {
  const { env, dbPath } = isolatedEnv(t);
  assert.equal(ingest(env, "leaky", [`deploy with ${FAKE.github}`, "done"]).status, "updated");
  assert.equal(ingest(env, "secret", ["first private draft", "noted"]).status, "updated");
  assert.equal(ingest(env, "secret", ["first private draft", "noted", `${PRIVATE_MARKER} forget this`]).status, "private");

  const db = initDb(dbPath, { autoMigrate: false });
  try {
    const rows = db.prepare("SELECT conversation_id, content FROM messages ORDER BY id").all();
    assert.deepEqual(rows.map(({ conversation_id }) => conversation_id), ["retinue:leaky", "retinue:leaky"]);
    assert.equal(rows[0].content, "deploy with [REDACTED:github_token]");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE id = 'retinue:secret'").get().n, 0);
    assert.equal(searchMessages(db, FAKE.github).length, 0);
    assert.equal(searchMessages(db, "private draft").length, 0);
    assert.equal(searchMessages(db, "REDACTED").length, 1);
  } finally {
    db.close();
  }
  // Re-ingesting the same redacted snapshot is recognised as unchanged.
  assert.equal(ingest(env, "leaky", [`deploy with ${FAKE.github}`, "done"]).status, "skipped");
});

test("upgrading a v4 database redacts stored messages and removes private conversations", (t) => {
  const { root } = isolatedEnv(t);
  const dbPath = path.join(root, "legacy.db");
  const seeded = initDb(dbPath, { autoMigrate: false });
  const insertConv = seeded.prepare("INSERT INTO conversations (id, source, workspace, workspace_slug, last_updated, message_count) VALUES (?, 'antigravity', 'Global / No Workspace', 'global', '2026-11-01T00:00:00Z', ?)");
  const insertMsg = seeded.prepare("INSERT INTO messages (conversation_id, step_index, role, content, timestamp) VALUES (?, ?, ?, ?, '2026-11-01T00:00:00Z')");
  insertConv.run("old-leak", 2);
  insertMsg.run("old-leak", 0, "USER", `my key is ${FAKE.openai}`);
  insertMsg.run("old-leak", 1, "AI", "Rotate it.");
  insertConv.run("old-private", 1);
  insertMsg.run("old-private", 0, "USER", `\n${PRIVATE_MARKER}\nsomething personal`);
  seeded.exec("PRAGMA user_version = 4");
  seeded.close();

  const upgraded = initDb(dbPath, { autoMigrate: false });
  try {
    assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
    assert.deepEqual(upgraded.prepare("SELECT id FROM conversations").all().map(({ id }) => id), ["old-leak"]);
    assert.equal(upgraded.prepare("SELECT content FROM messages WHERE step_index = 0").get().content, "my key is [REDACTED:api_key]");
    assert.equal(searchMessages(upgraded, FAKE.openai).length, 0);
    assert.equal(searchMessages(upgraded, "something personal").length, 0);
  } finally {
    upgraded.close();
  }
  // The upgrade runs once; a later open leaves rows alone.
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE messages SET content = ? WHERE step_index = 1").run(`again ${FAKE.openai}`);
  raw.close();
  const reopened = initDb(dbPath, { autoMigrate: false });
  try {
    assert.equal(reopened.prepare("SELECT content FROM messages WHERE step_index = 1").get().content, `again ${FAKE.openai}`);
  } finally {
    reopened.close();
  }
});
