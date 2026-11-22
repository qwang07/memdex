import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/memdex.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const ID = "11111111-1111-4111-8111-111111111111";

function isolatedStore(t) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memdex-hosts-")));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
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
  const { dir, dbPath, env } = isolatedStore(t);
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

  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
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
  const { dir, dbPath, env } = isolatedStore(t);
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

  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
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
