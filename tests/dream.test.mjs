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

import { initDb, upsertConversationRecord } from "../scripts/harness.mjs";
import { getDreamCandidates, markDreamed } from "../src/dream.mjs";
import { workspaceToSlug } from "../src/paths.mjs";

const CLI = fileURLToPath(new URL("../bin/memdex.mjs", import.meta.url));
const START = "2025-10-07T10:00:00Z";
const DURABLE = "The synthetic aurora ledger keeps records for seven hours.";
const EXISTING = "The synthetic aurora ledger uses local storage.";
const NOISE = "One-off synthetic command output.";

function isolatedStore(t) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memdex-dream-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const dir = (name) => {
    const result = path.join(temporary, name);
    fs.mkdirSync(result, { recursive: true });
    return result;
  };
  const home = dir("home");
  const memdexHome = dir("memory");
  const dbPath = path.join(memdexHome, "memory.db");
  const notesDir = path.join(memdexHome, "notes");
  return {
    dir, dbPath, notesDir,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MEMDEX_HOME: memdexHome,
      MEMDEX_DB: dbPath,
      MEMDEX_NOTES_DIR: notesDir,
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
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, input });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout;
}

function seed(env, id, workspace, contents) {
  const messages = contents.map((content, index) => ({
    role: "user",
    content,
    timestamp: new Date(Date.parse(START) + index * 1000).toISOString(),
  }));
  cli(["ingest", "--source", "retinue"], env, JSON.stringify({ id, workspace, messages }));
}

function watermark(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return { ...db.prepare("SELECT dreamed_at, dreamed_msg_count FROM conversations WHERE id = ?").get(id) };
  } finally {
    db.close();
  }
}

test("runs a manual Dream with only synthetic inputs through the local CLI and MCP stdio", { timeout: 20000 }, async (t) => {
  const { dir, dbPath, env, notesDir } = isolatedStore(t);
  const workspace = dir("project");
  const unrelated = dir("unrelated");
  const facts = [DURABLE, DURABLE, EXISTING, NOISE, NOISE];
  for (const [index, fact] of facts.entries()) seed(env, "p" + index, workspace, [fact]);
  seed(env, "unrelated", unrelated, ["A synthetic secret from another project."]);

  const hook = () => JSON.parse(cli(["hook", "session-start", "--host", "plain"], env, JSON.stringify({ workspace })));
  assert.match(hook().additionalContext, /\b6 unsynthesized session/);

  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "dream-fixture", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: 5000 });
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
      assert.ok(!result.isError, result.content?.[0]?.text);
      return result.content[0].text;
    };

    const candidateOutput = await call("get_dream_candidates", { workspace, source: "retinue", limit: 10 });
    const { candidates } = JSON.parse(candidateOutput);
    assert.equal(candidates.length, 5);
    assert.doesNotMatch(candidateOutput, /synthetic secret/);
    assert.deepEqual(JSON.parse(await call("get_dream_candidates", {})).candidates, []);
    assert.deepEqual(JSON.parse(await call("get_dream_candidates", { workspace, source: "codex" })).candidates, []);

    await call("upsert_memory", {
      scope: "project", workspace, type: "project", slug: "storage", name: "Storage",
      description: "Existing storage decision.", content: EXISTING,
    });
    assert.match(await call("search_past_memory", {
      query: "uses local storage", layer: "notes", project: workspace,
    }), /Existing storage decision/);

    // The fixture classification deliberately selects only the new durable fact.
    const sources = candidates.filter((candidate) => candidate.messages.some((message) => message.content === DURABLE))
      .map((candidate) => candidate.conversation_id);
    assert.deepEqual(sources, ["retinue:p0", "retinue:p1"]);
    const retentionResponse = await call("upsert_memory", {
      scope: "project", workspace, type: "project", slug: "retention", name: "Retention",
      description: "Seven-hour retention for the synthetic aurora ledger.", content: DURABLE, sources,
    });
    assert.match(retentionResponse, /Saved L2 memory note/);

    const projectNotes = path.join(notesDir, "projects", workspaceToSlug(workspace));
    assert.deepEqual(fs.readdirSync(projectNotes).sort(), ["MEMORY.md", "retention.md", "storage.md"]);
    const note = fs.readFileSync(path.join(projectNotes, "retention.md"), "utf8");
    assert.ok(note.includes(DURABLE));
    assert.doesNotMatch(note, /One-off|uses local storage/);
    assert.match(fs.readFileSync(path.join(projectNotes, "MEMORY.md"), "utf8"), /Seven-hour retention/);
    assert.match(hook().additionalContext, /unsynthesized session/);

    const appendedText = "A new synthetic discussion arrived during the review.";
    seed(env, "p0", workspace, [DURABLE, appendedText]);
    const receipts = candidates.map((candidate) => candidate.receipt);
    const wrongScope = JSON.parse(await call("mark_dreamed", { workspace: unrelated, receipts: [receipts[0]] }));
    assert.equal(wrongScope.results[0].status, "not_found");
    const marked = JSON.parse(await call("mark_dreamed", { workspace, receipts }));
    assert.deepEqual(marked.results.map((result) => result.status), Array(5).fill("marked"));
    assert.equal(marked.results[0].pending_message_count, 1);
    assert.equal(watermark(dbPath, "retinue:p0").dreamed_msg_count, 1);
    assert.deepEqual(watermark(dbPath, "retinue:unrelated"), { dreamed_at: "", dreamed_msg_count: 0 });

    const retry = JSON.parse(await call("mark_dreamed", { workspace, receipts: [receipts[0], receipts[0]] }));
    assert.ok(retry.results.every((result) => result.status === "already_marked"));
    const pending = JSON.parse(await call("get_dream_candidates", { workspace })).candidates;
    assert.deepEqual(pending.map((candidate) => candidate.messages.map((message) => message.content)), [[appendedText]]);
    assert.equal(pending[0].receipt.from_message_count, 1);
    assert.equal(pending[0].receipt.through_message_count, 2);

    const after = hook().additionalContext;
    assert.match(after, /Seven-hour retention/);
    assert.doesNotMatch(after, /unsynthesized session/);
    const recall = cli(["search", "seven-hour retention", "--layer", "notes", "--project", workspace], env);
    assert.match(recall, /Retention/);
  } finally {
    await client.close();
  }
});

test("bounds Dream windows, rejects stale or gapped receipts, and replays them idempotently", (t) => {
  const { dir, dbPath } = isolatedStore(t);
  const workspace = dir("scoped");
  const db = initDb(dbPath, { autoMigrate: false });
  const firstMark = new Date("2025-10-09T00:00:00Z");
  const secondMark = new Date("2025-10-11T00:00:00Z");
  const store = (id, source, scope, texts) => {
    upsertConversationRecord(db, {
      id, source, workspace: scope, lastUpdated: START,
      messages: texts.map((content, stepIndex) => ({ role: "USER", content, stepIndex, timestamp: START })),
    });
  };

  try {
    store("codex:scope", "codex", workspace, ["first", "second", "third"]);
    store("gemini-cli:scope", "gemini-cli", workspace, ["other source"]);
    store("global-conversation", "antigravity", undefined, ["global only"]);
    assert.throws(() => getDreamCandidates(db, { workspace: "scoped" }), /absolute path/);
    assert.deepEqual(getDreamCandidates(db).candidates.map(({ conversation_id }) => conversation_id), ["global-conversation"]);
    assert.equal(getDreamCandidates(db, { workspace, limit: 1 }).candidates.length, 1);

    const query = () => getDreamCandidates(db, { workspace, source: "codex", maxMessages: 2 }).candidates[0];
    const original = query();
    assert.deepEqual(original.messages.map(({ content }) => content), ["first", "second"]);
    assert.equal(original.receipt.through_message_count, 2);
    const gapped = { ...original.receipt, from_message_count: 1 };
    assert.equal(markDreamed(db, { workspace, receipts: [gapped], now: firstMark }).results[0].status, "stale");

    store("codex:scope", "codex", workspace, ["edited first", "second", "third"]);
    assert.equal(markDreamed(db, { workspace, receipts: [original.receipt], now: firstMark }).results[0].status, "stale");
    assert.equal(watermark(dbPath, "codex:scope").dreamed_msg_count, 0);

    const current = query().receipt;
    assert.throws(() => markDreamed(db, {
      workspace, receipts: [current, { ...current, through_message_count: 0 }], now: firstMark,
    }), /Invalid Dream receipt/);
    assert.equal(watermark(dbPath, "codex:scope").dreamed_msg_count, 0);

    const { results } = markDreamed(db, { workspace, receipts: [current, current], now: firstMark });
    assert.deepEqual(results.map(({ status }) => status), ["marked", "already_marked"]);
    assert.equal(results[0].pending_message_count, 1);
    assert.equal(markDreamed(db, { workspace, receipts: [current], now: secondMark }).results[0].status, "already_marked");
    assert.equal(watermark(dbPath, "codex:scope").dreamed_at, firstMark.toISOString());

    const remaining = query();
    assert.deepEqual(remaining.messages.map(({ content }) => content), ["third"]);
    assert.equal(remaining.receipt.from_message_count, 2);
    assert.equal(markDreamed(db, { workspace, receipts: [remaining.receipt], now: secondMark }).results[0].pending_message_count, 0);
    assert.equal(query(), undefined);
    assert.equal(watermark(dbPath, "gemini-cli:scope").dreamed_msg_count, 0);
  } finally {
    db.close();
  }
});
