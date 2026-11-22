import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { readTranscript, transcriptSnapshot } from "../../src/collectors/files.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = path.join(repo, "tests", "fixtures", "codex-l3");
const cli = path.join(repo, "bin", "memdex.mjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "memdex-codex-l3-"));
const liveId = "11111111-1111-4111-8111-111111111111";
const archiveId = "22222222-2222-4222-8222-222222222222";
const codexId = "codex:" + liveId;
const oldWatermark = "2025-10-07T10:03:00.000Z";

function makeDir(...parts) {
  const location = path.join(scratch, ...parts);
  fs.mkdirSync(location, { recursive: true });
  return fs.realpathSync(location);
}

function fixture(name) {
  return fs.readFileSync(path.join(fixtures, name), "utf8");
}

function writeRollout(location, template, workspace) {
  const escapedWorkspace = JSON.stringify(workspace).slice(1, -1);
  const contents = fixture(template)
    .replace("__CODEX_PROJECT__", () => escapedWorkspace)
    .replace("__ARCHIVED_PROJECT__", () => escapedWorkspace);
  fs.writeFileSync(location, contents);
  return contents;
}

function cliRun(args, env) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: repo,
    env,
  });
  assert.equal(result.status, 0, String(result.error ?? result.stderr));
  return result.stdout;
}

function readRows(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return {
      conversations: db.prepare("SELECT * FROM conversations ORDER BY id").all(),
      messages: db.prepare("SELECT conversation_id, role, content, timestamp FROM messages ORDER BY conversation_id, step_index, id").all(),
    };
  } finally {
    db.close();
  }
}

try {
  const liveRoot = makeDir("codex-home", "sessions");
  const archivedRoot = makeDir("codex-home", "archived_sessions");
  const liveDir = makeDir("codex-home", "sessions", "2025", "10", "07");
  const brainRoot = makeDir("antigravity-brain");
  const brainTranscriptDir = makeDir("antigravity-brain", liveId, ".system_generated", "logs");
  const liveWorkspace = makeDir("codex-starlight");
  const archiveWorkspace = makeDir("codex-lantern");
  let liveWorkspaceInput = liveWorkspace;
  if (process.platform !== "win32") {
    liveWorkspaceInput = path.join(scratch, "codex-starlight-alias");
    fs.symlinkSync(liveWorkspace, liveWorkspaceInput, "dir");
  }

  const liveFile = path.join(liveDir, "rollout-2025-10-07T10-00-00-" + liveId + ".jsonl");
  const duplicateFile = path.join(archivedRoot, path.basename(liveFile));
  const archiveFile = path.join(archivedRoot, "rollout-2025-10-07T10-01-00-" + archiveId + ".jsonl");
  const liveText = writeRollout(liveFile, "rollout-live.jsonl", liveWorkspaceInput);
  const shorterCopy = liveText.slice(0, liveText.lastIndexOf("\n") + 1);
  fs.writeFileSync(duplicateFile, shorterCopy);
  writeRollout(archiveFile, "rollout-archived.jsonl", archiveWorkspace);
  const invalidCopy = path.join(archivedRoot, "rollout-incomplete-copy.jsonl");
  fs.writeFileSync(invalidCopy, liveText.split("\n", 1)[0] + "\n");
  const liveMtime = new Date("2025-10-08T00:00:00.000Z");
  fs.utimesSync(liveFile, liveMtime, liveMtime);
  fs.utimesSync(duplicateFile, liveMtime, liveMtime);
  fs.writeFileSync(path.join(liveDir, "rollout-invalid.jsonl"), '{"type":"response_item","payload":{}}\n');
  fs.writeFileSync(path.join(liveDir, "history.jsonl"), liveText);
  if (process.platform !== "win32") {
    const unrelated = makeDir("not-a-codex-root");
    fs.writeFileSync(path.join(unrelated, "rollout-unrelated.jsonl"), liveText.replace(liveId, "55555555-5555-4555-8555-555555555555"));
    fs.symlinkSync(unrelated, path.join(liveRoot, "linked-directory"), "dir");
    const target = path.join(unrelated, "rollout-unrelated.jsonl");
    const link = path.join(archivedRoot, "rollout-linked.jsonl");
    fs.symlinkSync(target, link);
    const targetSnapshot = transcriptSnapshot(target);
    assert.ok(targetSnapshot);
    assert.equal(transcriptSnapshot(link), null);
    assert.equal(readTranscript({ ...targetSnapshot, sourcePath: link }), null);
  }
  fs.copyFileSync(path.join(fixtures, "antigravity-transcript.jsonl"), path.join(brainTranscriptDir, "transcript.jsonl"));

  const memoryHome = makeDir("memory");
  const dbPath = path.join(memoryHome, "memory.db");
  const env = {
    ...process.env,
    MEMDEX_HOME: memoryHome,
    MEMDEX_DB: dbPath,
    MEMDEX_NOTES_DIR: path.join(memoryHome, "notes"),
    MEMDEX_BRAIN_DIRS: brainRoot,
    MEMDEX_CODEX_DIRS: [liveRoot, archivedRoot].join(path.delimiter),
  };

  // A newer copy with no usable messages must not shadow the usable copies.
  const laterMtime = new Date("2025-10-08T00:00:01.000Z");
  fs.utimesSync(invalidCopy, laterMtime, laterMtime);

  const first = JSON.parse(cliRun(["sync"], env));
  assert.equal(first.updated, 3, "sync must index two Codex threads and one Antigravity conversation");
  assert.equal(first.totalConversations, 3);
  assert.equal(first.totalMessages, 6);
  const rows = readRows(dbPath);
  assert.deepEqual(rows.conversations.map(({ id, source }) => [id, source]), [
    [liveId, "antigravity"],
    [codexId, "codex"],
    ["codex:" + archiveId, "codex"],
  ]);
  const live = rows.conversations.find((conversation) => conversation.id === codexId);
  const archive = rows.conversations.find((conversation) => conversation.id === "codex:" + archiveId);
  assert.equal(live.workspace, liveWorkspace, "prefer session_meta.cwd and normalize symlinks");
  assert.equal(live.source_path, liveFile, "prefer the larger copy when usable rollouts have the same mtime");
  assert.equal(archive.workspace, archiveWorkspace, "use absolute turn_context.cwd when metadata lacks cwd");
  assert.equal(Date.parse(live.last_updated), Date.parse(oldWatermark));
  assert.equal(rows.messages.some((message) => message.content.includes("NOISE-")), false);
  assert.deepEqual(rows.messages.filter((message) => message.conversation_id === codexId).map(({ role }) => role), ["USER", "AI"]);

  const checks = [
    ["codex", "codex-starlight", "CODEX-LIVE-DECISION", /CODEX-ARCHIVED-DECISION|ANTIGRAVITY-DECISION/],
    ["codex", "codex-lantern", "CODEX-ARCHIVED-DECISION", /CODEX-LIVE-DECISION|ANTIGRAVITY-DECISION/],
    ["antigravity", "antigravity-glacier", "ANTIGRAVITY-DECISION", /CODEX-(LIVE|ARCHIVED)-DECISION/],
  ];
  for (const [source, project, include, exclude] of checks) {
    const hit = cliRun(["search", "aurora ledger", "--source", source, "--project", project], env);
    assert.ok(hit.includes(include), hit);
    assert.doesNotMatch(hit, exclude);
  }
  assert.match(cliRun(["list", "--source", "codex", "--project", "codex-starlight"], env), /codex:11111111-1111-4111-8111-111111111111/);

  const second = JSON.parse(cliRun(["sync"], env));
  assert.equal(second.updated, 0);
  assert.equal(second.skipped, 3);
  assert.equal(second.totalMessages, 6);
  assert.deepEqual(readRows(dbPath), rows, "an unchanged sync must preserve rows and values");

  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE conversations SET dreamed_at = ?, dreamed_msg_count = 2 WHERE id = ?").run(oldWatermark, codexId);
  } finally {
    db.close();
  }
  fs.writeFileSync(liveFile, liveText.slice(0, liveText.lastIndexOf("\n") + 1) + fixture("rollout-append.jsonl"));
  const appended = JSON.parse(cliRun(["sync"], env));
  assert.equal(appended.updated, 1);
  assert.equal(appended.totalConversations, 3);
  assert.equal(appended.totalMessages, 8);
  const appendedRows = readRows(dbPath);
  const appendedLive = appendedRows.conversations.find((conversation) => conversation.id === codexId);
  assert.equal(appendedLive.dreamed_at, oldWatermark);
  assert.equal(appendedLive.dreamed_msg_count, 2);
  assert.equal(appendedLive.message_count, 4);
  assert.equal(Date.parse(appendedLive.last_updated), Date.parse("2025-10-07T10:07:00.000Z"));
  assert.equal(appendedRows.messages.filter(({ conversation_id, role }) => conversation_id === codexId && role === "USER").length, 2);
  assert.match(cliRun(["search", "aurora ledger", "--source", "codex", "--project", "codex-starlight"], env), /CODEX-APPENDED-DECISION/);

  const forced = JSON.parse(cliRun(["sync", "--force"], env));
  assert.equal(forced.updated, 3);
  assert.deepEqual(readRows(dbPath), appendedRows, "force sync must not duplicate rows or reset the watermark");

  const onlyAntigravity = makeDir("antigravity-only");
  const disabled = JSON.parse(cliRun(["sync"], {
    ...env,
    MEMDEX_HOME: onlyAntigravity,
    MEMDEX_DB: path.join(onlyAntigravity, "memory.db"),
    MEMDEX_NOTES_DIR: path.join(onlyAntigravity, "notes"),
    MEMDEX_CODEX_DIRS: "",
  }));
  assert.equal(disabled.totalConversations, 1, "an empty Codex override must disable discovery");
  assert.equal(disabled.totalMessages, 2);

  console.log("Codex L3 CLI acceptance passed: source isolation, project filters, ID collisions, incremental reload, archive deduplication, force sync, and empty-root override.");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
