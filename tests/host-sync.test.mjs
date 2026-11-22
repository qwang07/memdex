import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ingestConversation, initDb, listConversations } from "memdex";

const CLI = fileURLToPath(new URL("../bin/memdex.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const ID = "11111111-1111-4111-8111-111111111111";

function isolatedStore(t) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memdex-hosts-")));
  const open = [];
  t.after(() => {
    for (const db of open) db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const dir = (...names) => {
    const location = path.join(scratch, ...names);
    fs.mkdirSync(location, { recursive: true });
    return location;
  };
  const home = dir("home");
  const memory = dir("memory");
  return {
    dir,
    dbPath: path.join(memory, "memory.db"),
    openDb() {
      const db = new DatabaseSync(path.join(memory, "memory.db"));
      open.push(db);
      return db;
    },
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MEMDEX_HOME: memory,
      MEMDEX_DB: path.join(memory, "memory.db"),
      MEMDEX_NOTES_DIR: path.join(memory, "notes"),
      CODEX_HOME: dir("codex"),
      CLAUDE_CONFIG_DIR: dir("claude"),
      GEMINI_CLI_HOME: home,
      MEMDEX_BRAIN_DIRS: dir("brain"),
      MEMDEX_CODEX_DIRS: "",
      MEMDEX_CLAUDE_DIRS: "",
      MEMDEX_GEMINI_DIRS: "",
    },
  };
}

function cli(args, env, input) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", input });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout;
}

function loadFixture(name, workspace) {
  const text = fs.readFileSync(path.join(FIXTURES, name), "utf8");
  return text.replaceAll("__WORKSPACE__", () => JSON.stringify(workspace).slice(1, -1));
}

test("syncs Claude main transcripts and safely reindexes updates", (t) => {
  const { dir, openDb, env } = isolatedStore(t);
  delete env.MEMDEX_CLAUDE_DIRS;
  const project = dir("claude", "projects", "-encoded-workspace");
  const workspace = dir("claude-ledger");
  const transcript = path.join(project, ID + ".jsonl");
  const text = loadFixture("hosts/claude.jsonl", workspace);
  fs.writeFileSync(transcript, text + "{unfinished");
  const duplicate = path.join(dir("claude", "projects", "-copy"), ID + ".jsonl");
  fs.writeFileSync(duplicate, text.replace("CLAUDE-WINDOW", "NOISE-OLDER-COPY"));
  const older = new Date("2025-10-01");
  fs.utimesSync(duplicate, older, older);
  fs.writeFileSync(path.join(dir("claude", "projects", "-encoded-workspace", ID, "subagents"), ID + ".jsonl"),
    text.replaceAll(ID, "22222222-2222-4222-8222-222222222222"));

  const first = JSON.parse(cli(["sync"], env));
  assert.equal(first.updated, 1);
  assert.equal(first.totalMessages, 2);
  const hit = cli(["search", "aurora ledger", "--source", "claude-code", "--project", "claude-ledger"], env);
  assert.match(hit, /CLAUDE-WINDOW/);
  assert.doesNotMatch(hit, /NOISE-/);
  assert.match(cli(["list", "--source", "claude-code", "--project", "unrelated"], env), /^$/);
  assert.equal(JSON.parse(cli(["sync"], env)).skipped, 1);

  const db = openDb();
  assert.equal(db.prepare("SELECT workspace FROM conversations WHERE id = ?").get("claude-code:" + ID).workspace, workspace);
  db.prepare("UPDATE conversations SET dreamed_at = ?, dreamed_msg_count = 2 WHERE id = ?").run("2025-10-07", "claude-code:" + ID);
  fs.writeFileSync(transcript, text + JSON.stringify({
    type: "assistant", uuid: "a2", parentUuid: "tool", timestamp: "2025-10-07T10:03:00Z",
    message: { role: "assistant", content: "Follow-up for the aurora ledger." },
  }) + "\n");
  const appended = JSON.parse(cli(["sync"], env));
  assert.equal(appended.updated, 1);
  assert.equal(appended.totalMessages, 3);
  assert.equal(db.prepare("SELECT dreamed_at FROM conversations WHERE id = ?").get("claude-code:" + ID).dreamed_at, "2025-10-07");
  assert.equal(JSON.parse(cli(["sync", "--force"], env)).updated, 1);
  assert.equal(JSON.parse(cli(["sync"], { ...env, MEMDEX_CLAUDE_DIRS: "" })).scanned, 0);
});

test("syncs Gemini JSONL replay and legacy JSON with independent workspaces", (t) => {
  const { dir, openDb, env } = isolatedStore(t);
  delete env.MEMDEX_GEMINI_DIRS;
  const liveProject = dir("home", ".gemini", "tmp", "modern");
  const legacyProject = dir("home", ".gemini", "tmp", "legacy");
  const workspace = dir("gemini-ledger");
  fs.writeFileSync(path.join(liveProject, ".project_root"), workspace);
  const live = path.join(dir("home", ".gemini", "tmp", "modern", "chats"), "session-modern.jsonl");
  const legacy = path.join(dir("home", ".gemini", "tmp", "legacy", "chats"), "session-legacy.json");
  const text = loadFixture("hosts/gemini.jsonl");
  fs.writeFileSync(live, text + "{unfinished");
  fs.writeFileSync(legacy, loadFixture("hosts/gemini-legacy.json"));
  fs.writeFileSync(path.join(dir("home", ".gemini", "tmp", "modern", "chats", ID), "session-subagent.jsonl"),
    text.replaceAll(ID, "33333333-3333-4333-8333-333333333333"));
  const older = new Date("2025-10-01");
  const duplicate = path.join(path.dirname(legacy), "session-copy.jsonl");
  fs.writeFileSync(duplicate, text.replace("GEMINI-RESULT", "NOISE-OLDER-COPY"));
  fs.utimesSync(duplicate, older, older);

  const first = JSON.parse(cli(["sync"], env));
  assert.equal(first.updated, 2);
  assert.equal(first.totalMessages, 4);
  const hit = cli(["search", "aurora ledger", "--source", "gemini-cli", "--project", "gemini-ledger"], env);
  assert.match(hit, /GEMINI-RESULT/);
  assert.doesNotMatch(hit, /GEMINI-LEGACY|NOISE-/);
  assert.match(cli(["list", "--source", "gemini-cli", "--project", "unrelated"], env), /^$/);
  assert.equal(JSON.parse(cli(["sync"], env)).skipped, 2);

  const db = openDb();
  assert.equal(db.prepare("SELECT workspace FROM conversations WHERE id = ?").get("gemini-cli:" + ID).workspace, workspace);
  db.prepare("UPDATE conversations SET dreamed_msg_count = 2 WHERE id = ?").run("gemini-cli:" + ID);
  fs.writeFileSync(live, text + JSON.stringify({ $rewindTo: "user" }) + "\n");
  const rewound = JSON.parse(cli(["sync"], env));
  assert.equal(rewound.updated, 1);
  assert.equal(rewound.totalMessages, 2);
  assert.equal(db.prepare("SELECT dreamed_msg_count FROM conversations WHERE id = ?").get("gemini-cli:" + ID).dreamed_msg_count, 2);

  fs.writeFileSync(path.join(legacyProject, ".project_root"), dir("legacy-ledger"));
  assert.equal(JSON.parse(cli(["sync"], env)).updated, 1);
  assert.match(cli(["list", "--source", "gemini-cli", "--project", "legacy-ledger"], env), /gemini-cli:22222222/);
  assert.equal(JSON.parse(cli(["sync", "--force"], env)).updated, 2);
});

test("ingests Retinue snapshots through stdin and the public package API", (t) => {
  const { dir, dbPath, env } = isolatedStore(t);
  const workspace = dir("retinue-ledger");
  const fixture = loadFixture("hosts/retinue.json", workspace);
  const snapshot = JSON.parse(fixture);
  const invalid = spawnSync(process.execPath, [CLI, "ingest", "--source", "retinue"], {
    env, encoding: "utf8", input: "SYNTHETIC-INVALID-JSON",
  });
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stderr, /SYNTHETIC-INVALID-JSON/);
  assert.equal(fs.existsSync(dbPath), false);
  assert.throws(() => ingestConversation({ ...snapshot, workspace: "relative" }, { dbPath }), /absolute workspace/);
  assert.throws(() => ingestConversation({
    ...snapshot, messages: [{ role: "tool", content: "reject", timestamp: "2025-10-07T10:00:00Z" }],
  }, { dbPath }), /role user or assistant/);
  assert.equal(fs.existsSync(dbPath), false);

  const command = ["ingest", "--source", "retinue"];
  const id = "retinue:" + snapshot.id;
  const result = JSON.parse(cli(command, env, fixture));
  assert.deepEqual(result, { id, source: "retinue", status: "updated" });
  assert.equal(JSON.parse(cli(command, env, fixture)).status, "skipped");

  const db = initDb(dbPath, { autoMigrate: false });
  try {
    db.prepare("UPDATE conversations SET dreamed_at = ?, dreamed_msg_count = 2 WHERE id = ?").run("2025-10-07", id);
    const newer = {
      ...snapshot,
      messages: [...snapshot.messages, {
        role: "assistant", content: "Retinue updated the aurora ledger.", timestamp: "2025-10-07T11:00:00+00:00",
      }],
    };
    assert.equal(ingestConversation(newer, { dbPath }).status, "updated");
    assert.equal(ingestConversation(snapshot, { dbPath }).status, "skipped");
    assert.equal(listConversations(db, { source: "retinue", project: "retinue-ledger" }).length, 1);
    assert.equal(listConversations(db, { source: "claude-code", project: "retinue-ledger" }).length, 0);
    const row = db.prepare("SELECT message_count, dreamed_at, dreamed_msg_count FROM conversations WHERE id = ?").get(id);
    assert.deepEqual({ ...row }, { message_count: 3, dreamed_at: "2025-10-07", dreamed_msg_count: 2 });
  } finally {
    db.close();
  }
});

test("shares multi-host sync, source filters, and workspaces across CLI and MCP stdio", { timeout: 20000 }, async (t) => {
  const { dir, env } = isolatedStore(t);
  const claudeDir = dir("claude", "projects", "encoded");
  const geminiProject = dir("home", ".gemini", "tmp", "gemini");
  const geminiChats = dir("home", ".gemini", "tmp", "gemini", "chats");
  const brainLogs = dir("brain", ID, ".system_generated", "logs");
  fs.writeFileSync(path.join(brainLogs, "transcript.jsonl"), loadFixture("codex-l3/antigravity-transcript.jsonl"));
  fs.writeFileSync(path.join(dir("codex", "sessions"), "rollout-host.jsonl"),
    loadFixture("codex-l3/rollout-live.jsonl").replace("__CODEX_PROJECT__", () => JSON.stringify(dir("codex-ledger")).slice(1, -1)));
  fs.writeFileSync(path.join(claudeDir, ID + ".jsonl"), loadFixture("hosts/claude.jsonl", dir("claude-ledger")));
  fs.writeFileSync(path.join(geminiProject, ".project_root"), dir("gemini-ledger"));
  fs.writeFileSync(path.join(geminiChats, "session-modern.jsonl"), loadFixture("hosts/gemini.jsonl"));
  cli(["ingest", "--source", "retinue"], env, loadFixture("hosts/retinue.json", dir("retinue-ledger")));

  env.MEMDEX_CODEX_DIRS = path.join(dir("codex"), "sessions");
  env.MEMDEX_CLAUDE_DIRS = path.join(dir("claude"), "projects");
  env.MEMDEX_GEMINI_DIRS = path.join(dir("home"), ".gemini", "tmp");

  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "multi-host-fixture", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: 5000 });
    const call = async (name, args = {}) => {
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
      assert.ok(!response.isError, JSON.stringify(response));
      return response.content[0].text;
    };
    const first = await call("sync_memory_now");
    assert.match(first, /Updated: 4 \| Skipped: 0/);
    assert.match(first, /Database totals: 5 conversations, 10 messages/);
    assert.equal(JSON.parse(cli(["sync"], env)).skipped, 4);
    assert.match(await call("sync_memory_now", { force: true }), /Updated: 4 \| Skipped: 0/);

    const expected = [
      ["antigravity", "antigravity-glacier", "ANTIGRAVITY-DECISION"],
      ["codex", "codex-ledger", "CODEX-LIVE-DECISION"],
      ["claude-code", "claude-ledger", "CLAUDE-WINDOW"],
      ["gemini-cli", "gemini-ledger", "GEMINI-RESULT"],
      ["retinue", "retinue-ledger", "RETINUE-RESULT"],
    ];
    for (const [source, project, marker] of expected) {
      const request = { query: "aurora ledger", source, project, layer: "conversations" };
      const mcpHit = await call("search_past_memory", request);
      const cliHit = cli(["search", request.query, "--source", source, "--project", project], env);
      assert.ok(mcpHit.includes(marker), mcpHit);
      assert.ok(cliHit.includes(marker), cliHit);
      for (const [, , other] of expected) {
        if (other === marker) continue;
        assert.ok(!mcpHit.includes(other) && !cliHit.includes(other));
      }
      assert.match(await call("search_past_memory", { ...request, project: "unknown-project" }), /No past memory found/);
    }
  } finally {
    await client.close();
  }
});
