import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ingestConversation, initDb, listConversations } from "memdex";
import { workspaceToSlug } from "../src/paths.mjs";

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

function protobufStringField(number, value) {
  const bytes = Buffer.from(value);
  const size = [];
  let length = bytes.length;
  while (length >= 128) {
    size.push((length % 128) + 128);
    length = Math.floor(length / 128);
  }
  return Buffer.concat([Buffer.from([number * 8 + 2, ...size, length]), bytes]);
}

function writeAntigravityMetadata(filename, session, data) {
  const native = new DatabaseSync(filename);
  try {
    native.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT);
      CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB);
    `);
    native.prepare("INSERT INTO trajectory_meta VALUES (?, ?)").run("trajectory", session);
    native.prepare("INSERT INTO trajectory_metadata_blob VALUES (?, ?)").run("metadata", data);
  } finally {
    native.close();
  }
}

test("syncs Antigravity workspaces from same-session metadata, including previously global rows", (t) => {
  const { dir, openDb, env } = isolatedStore(t);
  const workspace = dir("native ledger 空间");
  const gitRoot = dir("different-git-root");
  const databases = dir("conversations");
  const ready = path.join(databases, ID + ".db");
  const lateId = "22222222-2222-4222-8222-222222222222";
  const late = path.join(databases, lateId + ".db");
  const metadata = Buffer.concat([
    protobufStringField(1, Buffer.concat([
      protobufStringField(1, pathToFileURL(workspace).href),
      protobufStringField(2, pathToFileURL(gitRoot).href),
    ])),
    // An unrelated length-delimited field exercises multi-byte length decoding.
    protobufStringField(3, "a".repeat(150)),
    protobufStringField(7, pathToFileURL(workspace).href),
  ]);
  for (const id of [ID, lateId]) {
    const logs = dir("brain", id, ".system_generated", "logs");
    fs.writeFileSync(path.join(logs, "transcript.jsonl"), JSON.stringify({
      type: "USER_INPUT", content: "Antigravity native workspace lantern", created_at: "2025-10-07T10:00:00Z",
    }) + "\n");
  }
  writeAntigravityMetadata(ready, ID, metadata);
  const originalMetadata = fs.readFileSync(ready);

  assert.equal(JSON.parse(cli(["sync"], env)).updated, 2);
  const db = openDb();
  const workspaceOf = db.prepare("SELECT workspace FROM conversations WHERE id = ?");
  assert.equal(workspaceOf.get(ID).workspace, workspace);
  assert.equal(workspaceOf.get(lateId).workspace, "Global / No Workspace");

  writeAntigravityMetadata(late, lateId, protobufStringField(7, pathToFileURL(workspace).href));
  const repaired = JSON.parse(cli(["sync"], env));
  assert.equal(repaired.updated, 1);
  assert.equal(repaired.skipped, 1);
  assert.equal(repaired.totalMessages, 2);
  assert.equal(workspaceOf.get(lateId).workspace, workspace);
  const found = cli(["search", "lantern", "--source", "antigravity", "--project", workspaceToSlug(workspace)], env);
  assert.ok(found.includes(ID) && found.includes(lateId));
  assert.equal(JSON.parse(cli(["sync"], env)).skipped, 2);

  assert.deepEqual(fs.readFileSync(ready), originalMetadata);

  // Keep a known project when a side database later supplies a different workspace.
  fs.rmSync(ready);
  writeAntigravityMetadata(ready, ID, protobufStringField(7, pathToFileURL(gitRoot).href));
  assert.equal(JSON.parse(cli(["sync", "--force"], env)).updated, 2);
  assert.equal(workspaceOf.get(ID).workspace, workspace);
});

test("falls back to transcript attribution when Antigravity metadata is unusable", (t) => {
  const { dir, openDb, env } = isolatedStore(t);
  const databases = dir("conversations");
  const firstUri = pathToFileURL(dir("workspace-one")).href;
  const secondUri = pathToFileURL(dir("workspace-two")).href;
  const sides = [
    (file) => writeAntigravityMetadata(file, "another-session", protobufStringField(7, firstUri)),
    (file) => fs.writeFileSync(file, "not a database"),
    (file, id) => writeAntigravityMetadata(file, id, Buffer.from([0x3a, 0x09, 0x01])),
    (file, id) => writeAntigravityMetadata(file, id, Buffer.concat([
      protobufStringField(1, protobufStringField(1, firstUri)),
      protobufStringField(7, secondUri),
    ])),
  ];
  for (const [index, sidecar] of sides.entries()) {
    const id = "antigravity-fixture-" + index;
    const logs = dir("brain", id, ".system_generated", "logs");
    fs.writeFileSync(path.join(logs, "transcript.jsonl"), loadFixture("codex-l3/antigravity-transcript.jsonl"));
    sidecar(path.join(databases, id + ".db"), id);
  }

  const report = JSON.parse(cli(["sync"], env));
  assert.equal(report.updated, sides.length);
  assert.equal(report.totalMessages, sides.length * 2);
  const rows = openDb().prepare("SELECT workspace FROM conversations").all();
  assert.ok(rows.every(({ workspace }) => workspace === "/workspace/antigravity-glacier"));
});


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
  const pathHit = cli(["search", "violet-marzipan", "--source", "gemini-cli", "--project", "gemini-ledger"], env);
  assert.match(pathHit, /\/tmp\/blueprint is the source of truth for violet-marzipan/);
  assert.match(cli(["search", "NOISE-HOOK", "--source", "gemini-cli"], env), /No results found/);
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

test("Claude Code and Codex Stop hooks import only the reported session", (t) => {
  const { dir, openDb, env } = isolatedStore(t);
  delete env.MEMDEX_CLAUDE_DIRS;
  delete env.MEMDEX_CODEX_DIRS;
  const claudeProject = dir("claude", "projects", "-encoded-workspace");
  const claudeWorkspace = dir("claude-ledger");
  const claudeTranscript = path.join(claudeProject, ID + ".jsonl");
  fs.writeFileSync(claudeTranscript, loadFixture("hosts/claude.jsonl", claudeWorkspace));
  const otherClaude = "44444444-4444-4444-8444-444444444444";
  fs.writeFileSync(path.join(claudeProject, otherClaude + ".jsonl"),
    loadFixture("hosts/claude.jsonl", claudeWorkspace).replaceAll(ID, otherClaude));

  const codexDay = dir("codex", "sessions", "2025", "10", "07");
  const rollout = path.join(codexDay, "rollout-stop.jsonl");
  fs.writeFileSync(rollout,
    loadFixture("codex-l3/rollout-live.jsonl").replace("__CODEX_PROJECT__", () => JSON.stringify(dir("codex-ledger")).slice(1, -1)));

  const hook = (host, payload) => {
    const out = cli(["hook", "stop", "--host", host], env, JSON.stringify(payload));
    assert.equal(out.trim(), "{}");
  };
  hook("claude", { session_id: ID, transcript_path: claudeTranscript, cwd: claudeWorkspace, hook_event_name: "Stop" });
  hook("codex", { session_id: "s", transcript_path: rollout, cwd: dir("codex-ledger"), hook_event_name: "Stop" });

  const db = openDb();
  const ids = db.prepare("SELECT id FROM conversations ORDER BY id").all().map((row) => row.id);
  assert.deepEqual(ids, ["claude-code:" + ID, "codex:" + ID]);

  // A path outside the configured roots falls back to an incremental scan of that source only.
  const outside = path.join(dir("elsewhere"), ID + ".jsonl");
  fs.copyFileSync(claudeTranscript, outside);
  hook("claude", { session_id: ID, transcript_path: outside });
  const claudeRows = db.prepare("SELECT id, source_path FROM conversations WHERE source = 'claude-code' ORDER BY id").all();
  assert.deepEqual(claudeRows.map((row) => row.id), ["claude-code:" + ID, "claude-code:" + otherClaude]);
  assert.ok(claudeRows.every((row) => !row.source_path.startsWith(dir("elsewhere"))));

  const startup = JSON.parse(cli(["hook", "session-start", "--host", "codex"], env, JSON.stringify({ cwd: dir("codex-ledger") })));
  assert.deepEqual(startup, {});
});

test("classifies native Codex, Claude Code, and Retinue sub-sessions and hides them from default list", (t) => {
  const { dir, dbPath, openDb, env } = isolatedStore(t);
  delete env.MEMDEX_CODEX_DIRS;
  delete env.MEMDEX_CLAUDE_DIRS;

  const ws = dir("multi-sub");
  const codexSubId = "55555555-5555-4555-8555-555555555555";
  const codexMainId = "66666666-6666-4666-8666-666666666666";
  const codexDir = dir("codex", "sessions", "2026", "11", "25");
  fs.writeFileSync(
    path.join(codexDir, "rollout-sub.jsonl"),
    [
      JSON.stringify({ timestamp: "2026-11-25T10:00:00Z", type: "session_meta", payload: { id: codexSubId, cwd: ws, source: { subagent: "review" } } }),
      JSON.stringify({ timestamp: "2026-11-25T10:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Review diff for sub-session test" }] } }),
    ].join("\n") + "\n"
  );
  fs.writeFileSync(
    path.join(codexDir, "rollout-main.jsonl"),
    [
      JSON.stringify({ timestamp: "2026-11-25T09:00:00Z", type: "session_meta", payload: { id: codexMainId, cwd: ws, source: "cli" } }),
      JSON.stringify({ timestamp: "2026-11-25T09:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Main human codex session" }] } }),
    ].join("\n") + "\n"
  );

  const claudeSubId = "77777777-7777-4777-8777-777777777777";
  const claudeDir = dir("claude", "projects", "-multi-sub");
  fs.writeFileSync(
    path.join(claudeDir, claudeSubId + ".jsonl"),
    JSON.stringify({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: claudeSubId,
      agentId: "agent-worker-1",
      cwd: ws,
      timestamp: "2026-11-25T10:01:00Z",
      message: { role: "user", content: "Inspect test coverage" },
    }) + "\n"
  );

  assert.equal(JSON.parse(cli(["sync"], env)).updated, 3);

  const retinueSub = ingestConversation({
    id: "ret-sub-1",
    workspace: ws,
    is_subsession: true,
    messages: [{ role: "user", content: "Background retinue helper", timestamp: "2026-11-25T10:02:00Z" }],
  }, { dbPath });
  assert.equal(retinueSub.status, "updated");

  const db = openDb();
  const rows = Object.fromEntries(
    db.prepare("SELECT id, is_subsession FROM conversations").all().map((r) => [r.id, r.is_subsession])
  );
  assert.equal(rows["codex:" + codexMainId], 0);
  assert.equal(rows["codex:" + codexSubId], 1);
  assert.equal(rows["claude-code:" + claudeSubId], 1);
  assert.equal(rows["retinue:ret-sub-1"], 1);

  const defaultList = cli(["list", "--project", ws, "--limit", "10"], env);
  assert.ok(defaultList.includes("codex:" + codexMainId));
  assert.ok(!defaultList.includes("codex:" + codexSubId));
  assert.ok(!defaultList.includes("claude-code:" + claudeSubId));
  assert.ok(!defaultList.includes("retinue:ret-sub-1"));

  const fullList = cli(["list", "--project", ws, "--limit", "10", "--include-subsessions"], env);
  assert.ok(fullList.includes("codex:" + codexSubId));
  assert.ok(fullList.includes("claude-code:" + claudeSubId));
  assert.ok(fullList.includes("retinue:ret-sub-1"));
  assert.ok(fullList.includes("[subsession]"));
});
