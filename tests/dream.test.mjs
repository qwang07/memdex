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

import { initDb, upsertConversationRecord, upsertMemory } from "../scripts/harness.mjs";
import { getDreamCandidates, listScopeNotes, markDreamed } from "../src/dream.mjs";
import { workspaceToSlug } from "../src/paths.mjs";

const CLI = fileURLToPath(new URL("../bin/memdex.mjs", import.meta.url));
const SKILLS = fileURLToPath(new URL("../skills/", import.meta.url));
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
  assert.match(hook().additionalContext, /\b5 unsynthesized session\(s\) in this project \(6 total\)/);

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

function seedNote(db, notesDir, { scope = "global", workspace = "", slug, updated, sources = [], content }) {
  return upsertMemory(db, {
    scope, workspace, type: "feedback", slug, name: "Note " + slug, description: "Synthetic rule " + slug,
    content: content ?? "Synthetic body " + slug, sources, updated, notesDir,
  });
}

test("lists every note in one exact scope, oldest first, with age and index visibility", (t) => {
  const { dir, dbPath, notesDir } = isolatedStore(t);
  const workspace = dir("project");
  const other = dir("other");
  const now = new Date("2026-11-25T00:00:00Z");
  const db = initDb(dbPath, { autoMigrate: false });
  try {
    // 50 global notes exceed the 50-line global index (header + 48 entries + footer): the 2 oldest are hidden.
    for (let i = 1; i <= 50; i += 1) {
      seedNote(db, notesDir, { slug: "g" + String(i).padStart(2, "0"), updated: `2026-10-${String(i % 28 + 1).padStart(2, "0")}T00:00:${String(i).padStart(2, "0")}Z` });
    }
    seedNote(db, notesDir, { scope: "project", workspace, slug: "fresh", updated: "2026-11-24T00:00:00Z" });
    seedNote(db, notesDir, { scope: "project", workspace, slug: "old", updated: "2026-09-01T00:00:00Z", sources: ["a", "b"] });
    seedNote(db, notesDir, { scope: "project", workspace: other, slug: "elsewhere", updated: "2026-09-01T00:00:00Z" });

    const global = listScopeNotes(db, { notesDir, now });
    assert.equal(global.scope, "global");
    assert.equal(global.total, 50);
    assert.equal(global.hidden, 2);
    const sorted = [...global.notes].sort((a, b) => a.updated.localeCompare(b.updated) || a.id.localeCompare(b.id));
    assert.deepEqual(global.notes.map(({ id }) => id), sorted.map(({ id }) => id));
    assert.deepEqual(global.notes.filter((note) => !note.in_index).map(({ id }) => id), global.notes.slice(0, 2).map(({ id }) => id));
    assert.ok(global.notes.every(({ id }) => id.startsWith("global/")));

    const project = listScopeNotes(db, { workspace, notesDir, now });
    assert.equal(project.scope, "project");
    assert.equal(project.workspace, workspace);
    assert.deepEqual(project.notes.map(({ id }) => id.split("/").pop()), ["old", "fresh"]);
    assert.deepEqual(project.notes.map(({ age_days, stale, source_count, in_index }) => ({ age_days, stale, source_count, in_index })), [
      { age_days: 85, stale: true, source_count: 2, in_index: true },
      { age_days: 1, stale: false, source_count: 0, in_index: true },
    ]);
    assert.equal(project.stale, 1);
    assert.equal(project.hidden, 0);
    assert.throws(() => listScopeNotes(db, { workspace: "project", notesDir }), /absolute path/);
  } finally {
    db.close();
  }
});

test("runs a note review through MCP stdio: merge, delete, and refresh until no note is hidden", { timeout: 20000 }, async (t) => {
  const { dbPath, env, notesDir } = isolatedStore(t);
  const db = initDb(dbPath, { autoMigrate: false });
  try {
    for (let i = 1; i <= 48; i += 1) {
      seedNote(db, notesDir, { slug: "keep-" + String(i).padStart(2, "0"), updated: "2026-11-01T00:00:00Z" });
    }
    seedNote(db, notesDir, { slug: "reply-zh", updated: "2026-08-01T00:00:00Z", sources: ["c1"], content: "Reply in Chinese." });
    seedNote(db, notesDir, { slug: "reply-chinese", updated: "2026-08-02T00:00:00Z", sources: ["c2"], content: "Answer in Chinese." });
  } finally {
    db.close();
  }
  const globalIndex = fs.readFileSync(path.join(notesDir, "global", "MEMORY.md"), "utf8");
  assert.match(globalIndex, /\+2 older note\(s\) omitted; list them with list_memory_notes/);

  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "note-review-fixture", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: 5000 });
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
      assert.ok(!result.isError, result.content?.[0]?.text);
      return result.content[0].text;
    };

    const before = JSON.parse(await call("list_memory_notes", {}));
    assert.equal(before.total, 50);
    assert.equal(before.hidden, 2);
    assert.deepEqual(before.notes.slice(0, 2).map(({ id, in_index }) => [id, in_index]), [
      ["global/reply-zh", false], ["global/reply-chinese", false],
    ]);

    // The fixture reviewer merges the duplicate pair into the older slug with both sources.
    await call("upsert_memory", {
      scope: "global", type: "feedback", slug: "reply-zh", name: "Reply language",
      description: "Reply in Chinese.", content: "Reply in Chinese.", sources: ["c1", "c2"],
    });
    await call("delete_memory", { id: "global/reply-chinese" });
    await call("delete_memory", { id: "global/keep-01" });

    const after = JSON.parse(await call("list_memory_notes", {}));
    assert.equal(after.total, 48);
    assert.equal(after.hidden, 0);
    const merged = after.notes.find(({ id }) => id === "global/reply-zh");
    assert.equal(merged.source_count, 2);
    assert.equal(merged.age_days, 0);
    assert.doesNotMatch(fs.readFileSync(path.join(notesDir, "global", "MEMORY.md"), "utf8"), /omitted/);
  } finally {
    await client.close();
  }
});

test("supports per-project incremental Dream, sub-session filtering, and project selectors over MCP stdio", { timeout: 20000 }, async (t) => {
  const { dir, dbPath, env } = isolatedStore(t);
  const projectA = dir("alpha-app");
  const projectB = dir("beta-app");
  const db = initDb(dbPath, { autoMigrate: false });
  try {
    const add = (id, workspace, updated, text) => {
      upsertConversationRecord(db, {
        id,
        source: "claude-code",
        workspace,
        lastUpdated: updated,
        messages: [{ role: "USER", content: text, stepIndex: 0, timestamp: updated }],
      });
    };
    add("main-old", projectA, "2026-11-10T10:00:00Z", "Older alpha architecture discussion");
    add("main-new", projectA, "2026-11-20T10:00:00Z", "Newest alpha architecture discussion");
    add("sub-bg", projectA, "2026-11-21T10:00:00Z", "Background (from the session that started this one): worker task");
    add("sub-task", projectA, "2026-11-22T10:00:00Z", "Task (from the session that started this one): lint check");
    add("other-proj", projectB, "2026-11-23T10:00:00Z", "Beta project work");

    // Default includes sub-sessions, resolves unique project directory name, returns newest-first and pending counts.
    const batch = getDreamCandidates(db, { project: "alpha-app", limit: 1 });
    assert.equal(batch.workspace, projectA);
    assert.equal(batch.total_pending, 4);
    assert.equal(batch.hidden_subsessions, 0);
    assert.deepEqual(batch.candidates.map((c) => c.conversation_id), ["sub-task"]);
    assert.equal(batch.candidates[0].is_subsession, true);

    // Full slug selector and includeSubsessions=false (main sessions only) also work.
    const mainOnly = getDreamCandidates(db, { project: workspaceToSlug(projectA), includeSubsessions: false, limit: 10 });
    assert.equal(mainOnly.total_pending, 2);
    assert.equal(mainOnly.hidden_subsessions, 2);
    assert.deepEqual(mainOnly.candidates.map((c) => c.conversation_id), ["main-new", "main-old"]);

    // Unknown project returns empty safely; conflicting workspace + project throws; markDreamed rejects unknown project.
    assert.deepEqual(getDreamCandidates(db, { project: "no-such-project" }), {
      workspace: "",
      total_pending: 0,
      hidden_subsessions: 0,
      candidates: [],
    });
    assert.throws(() => getDreamCandidates(db, { workspace: projectA, project: "beta-app" }), /conflicting/);
    assert.throws(() => markDreamed(db, { project: "no-such-project", receipts: [batch.candidates[0].receipt] }), /did not match/);

    // markDreamed accepts the same project selector.
    const marked = markDreamed(db, { project: "alpha-app", receipts: [mainOnly.candidates[0].receipt] });
    assert.equal(marked.results[0].status, "marked");

    const nextBatch = getDreamCandidates(db, { project: "alpha-app", limit: 5 });
    assert.equal(nextBatch.total_pending, 3);
    assert.deepEqual(nextBatch.candidates.map((c) => c.conversation_id), ["sub-task", "sub-bg", "main-old"]);
  } finally {
    db.close();
  }

  // Verify MCP stdio wiring for project + include_subsessions + mark_dreamed(project).
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "dream-project-fixture", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: 5000 });
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
      assert.ok(!result.isError, result.content?.[0]?.text);
      return JSON.parse(result.content[0].text);
    };

    const mcpMain = await call("get_dream_candidates", { project: "alpha-app", include_subsessions: false, limit: 5 });
    assert.equal(mcpMain.workspace, projectA);
    assert.equal(mcpMain.total_pending, 1);
    assert.equal(mcpMain.hidden_subsessions, 2);
    assert.deepEqual(mcpMain.candidates.map((c) => c.conversation_id), ["main-old"]);

    const mcpMarked = await call("mark_dreamed", { project: "alpha-app", receipts: [mcpMain.candidates[0].receipt] });
    assert.equal(mcpMarked.results[0].status, "marked");

    const mcpDefault = await call("get_dream_candidates", { project: "alpha-app", limit: 5 });
    assert.equal(mcpDefault.total_pending, 2);
    assert.equal(mcpDefault.hidden_subsessions, 0);
    assert.deepEqual(mcpDefault.candidates.map((c) => c.conversation_id), ["sub-task", "sub-bg"]);
  } finally {
    await client.close();
  }
});

test("ships the note review and incremental Dream procedures in the Dream and recall Skills", () => {
  const dream = fs.readFileSync(path.join(SKILLS, "memdex-dream", "SKILL.md"), "utf8");
  assert.match(/^description: (.+)$/m.exec(dream)?.[1] ?? "", /review existing notes/);
  assert.match(dream, /## Conversation review/);
  assert.match(dream, /## Note review/);
  assert.match(dream, /`list_memory_notes`/);
  assert.match(dream, /advances no watermark/);
  assert.match(dream, /incremental Dream/i);
  assert.match(dream, /`project`/);
  assert.match(dream, /`include_subsessions: false`/);
  assert.match(dream, /`total_pending`/);
  const recall = fs.readFileSync(path.join(SKILLS, "memdex", "SKILL.md"), "utf8");
  assert.match(recall, /`list_memory_notes`/);
  assert.match(recall, /`exclude_conversation_id`/);
  assert.match(recall, /`demote_recent_minutes: 0`/);
  assert.match(recall, /`tail: true`/);
  assert.match(recall, /`include_subsessions: true`/);
});
