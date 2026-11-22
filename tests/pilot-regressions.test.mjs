import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { initDb, listNotes, syncNotesFromDisk, upsertConversationRecord, upsertMemory, workspaceToSlug } from "../scripts/harness.mjs";

const cli = fileURLToPath(new URL("../bin/memdex.mjs", import.meta.url));
const date = "2025-10-07T10:00:00Z";

function testStore(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memdex-pilot-fixture-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = (...parts) => {
    const location = path.join(root, ...parts);
    fs.mkdirSync(location, { recursive: true });
    return location;
  };
  const home = dir("home");
  const memory = dir("memory");
  const dbPath = path.join(memory, "memory.db");
  const notesDir = path.join(memory, "notes");
  return {
    dir, dbPath, notesDir, root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      MEMDEX_HOME: memory,
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

async function withMcp(env, callback, preload) {
  const args = preload ? ["--import", preload, cli, "mcp"] : [cli, "mcp"];
  const transport = new StdioClientTransport({ command: process.execPath, args, env, stderr: "pipe" });
  const client = new Client({ name: "pilot-regressions", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: 5000 });
    return await callback((name, args = {}) =>
      client.callTool({ name, arguments: args }, undefined, { timeout: 5000 }));
  } finally {
    await client.close();
  }
}

function text(result) {
  assert.ok(!result.isError, result.content?.[0]?.text);
  return result.content[0].text;
}

function addConversation(db, id, workspace, content) {
  upsertConversationRecord(db, {
    id, source: "codex", workspace, lastUpdated: date,
    messages: [{ role: "USER", content, timestamp: date, stepIndex: 0 }],
  });
}

test("MCP and note listing resolve one exact project across both recall layers", { timeout: 20000 }, async (t) => {
  const { dir, dbPath, notesDir, env, root } = testStore(t);
  const target = dir("projects", "pilot");
  const sibling = dir("projects", "pilot-extra");
  const db = initDb(dbPath);
  try {
    for (const [workspace, marker] of [[target, "OWN"], [sibling, "SIBLING"]]) {
      upsertMemory(db, {
        scope: "project", workspace, type: "project", slug: "ledger", name: marker + "-NOTE",
        description: marker + "-NOTE", content: "Aurora ledger 航线 " + marker + "-NOTE", notesDir,
      });
      addConversation(db, marker + "-CONVERSATION", workspace, "Aurora ledger 航线 " + marker + "-CONVERSATION");
    }

    let alias = target;
    if (process.platform !== "win32") {
      alias = path.join(root, "project-alias");
      fs.symlinkSync(target, alias, "dir");
    }

    await withMcp(env, async (call) => {
      for (const query of ["Aurora ledger", "航线", "Aurora 航线", "Aurora 航线 未中"]) {
        const found = text(await call("search_past_memory", { query, project: target }));
        assert.match(found, /OWN-NOTE/);
        assert.match(found, /OWN-CONVERSATION/);
        assert.doesNotMatch(found, /SIBLING/);
      }
      for (const project of [alias + path.sep, workspaceToSlug(target), "pilot"]) {
        const found = text(await call("search_past_memory", { query: "Aurora", project }));
        assert.match(found, /OWN-NOTE/);
        assert.doesNotMatch(found, /SIBLING/);
      }
      assert.deepEqual(listNotes(db, { project: target }).map(({ name }) => name), ["OWN-NOTE"]);
      const recent = text(await call("list_recent_conversations", { project: target }));
      assert.match(recent, /OWN-CONVERSATION/);
      assert.doesNotMatch(recent, /SIBLING/);
      for (const command of [["search", "航线"], ["list"]]) {
        const result = spawnSync(process.execPath, [cli, ...command, "--project", target], { env, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /OWN-CONVERSATION/);
        assert.doesNotMatch(result.stdout, /SIBLING/);
      }

      addConversation(db, "AMBIGUOUS", dir("different-parent", "pilot"), "Aurora ledger");
      for (const project of ["pilot", "pilo"]) {
        assert.match(text(await call("search_past_memory", { query: "Aurora", project })), /No past memory found/);
      }
      assert.match(text(await call("search_past_memory", { query: "Aurora" })), /SIBLING-NOTE/);

      const legacySlug = "legacy-project-1234abcd";
      const legacyDir = path.join(notesDir, "projects", legacySlug);
      fs.mkdirSync(legacyDir);
      fs.writeFileSync(path.join(legacyDir, "ledger.md"),
        "---\nname: Legacy\ntype: project\nscope: project\n---\n\nAurora ledger LEGACY-NOTE\n");
      upsertMemory(db, {
        scope: "global", type: "user", slug: "ledger", name: "Global",
        description: "Aurora ledger", content: "Aurora ledger GLOBAL-NOTE", notesDir,
      });
      syncNotesFromDisk(db, { notesDir });

      const legacy = text(await call("search_past_memory", { query: "Aurora", project: legacySlug }));
      assert.match(legacy, /LEGACY-NOTE/);
      assert.doesNotMatch(legacy, /GLOBAL-NOTE/);
      const onlyGlobal = text(await call("search_past_memory", { query: "Aurora", project: "global" }));
      assert.match(onlyGlobal, /GLOBAL-NOTE/);
      assert.doesNotMatch(onlyGlobal, /LEGACY-NOTE/);
    });
  } finally {
    db.close();
  }
});

test("failed index rename rolls back an update and create across MCP restarts", { timeout: 20000 }, async (t) => {
  const { dir, dbPath, notesDir, env, root } = testStore(t);
  const workspace = dir("project");
  const payload = {
    scope: "project", workspace, type: "project", slug: "ledger", name: "Original",
    description: "oldindexsignal", content: "oldbodysignal", sources: ["fixture-thread"], updated: date,
  };
  const wsSlug = workspaceToSlug(workspace);
  const id = "projects/" + wsSlug + "/ledger";
  const index = path.join(notesDir, "projects", wsSlug, "MEMORY.md");
  const note = path.join(path.dirname(index), "ledger.md");
  const db = initDb(dbPath);
  try {
    addConversation(db, "fixture-thread", workspace, "Original synthetic material for Dream.");
  } finally {
    db.close();
  }

  const onlyCandidate = async (call) => {
    const output = text(await call("get_dream_candidates", { workspace }));
    const candidates = JSON.parse(output).candidates;
    assert.equal(candidates.length, 1);
    return candidates[0].receipt;
  };
  const receipt = await withMcp(env, async (call) => {
    assert.match(text(await call("upsert_memory", payload)), /Saved L2 memory note/);
    return onlyCandidate(call);
  });
  const oldTimestamp = new Date("2025-10-07T10:01:00Z");
  fs.utimesSync(note, oldTimestamp, oldTimestamp);
  const oldNote = fs.readFileSync(note, "utf8");
  const oldIndex = fs.readFileSync(index, "utf8");
  const preload = path.join(root, "fail-index-rename.mjs");
  fs.writeFileSync(preload, [
    'import fs from "node:fs";',
    'import { DatabaseSync } from "node:sqlite";',
    'const exec = DatabaseSync.prototype.exec;',
    'DatabaseSync.prototype.exec = function (sql) {',
    '  if (process.env.TEST_MEMDEX_COMMIT && sql === "COMMIT") throw new Error("synthetic commit failure");',
    '  return exec.call(this, sql);',
    '};',
    'const rename = fs.renameSync;',
    'fs.renameSync = (from, to) => {',
    '  if (to === process.env.TEST_MEMDEX_INDEX) {',
    '    const err = new Error("synthetic index rename failure");',
    '    err.code = "EACCES";',
    '    throw err;',
    '  }',
    '  return rename(from, to);',
    '};',
  ].join("\n"));
  const revised = { ...payload, name: "Revised", description: "newindexsignal", content: "newbodysignal" };
  await withMcp({ ...env, TEST_MEMDEX_INDEX: index }, async (call) => {
    for (const input of [revised, { ...revised, slug: "another" }]) {
      const failed = await call("upsert_memory", input);
      assert.equal(failed.isError, true);
      assert.match(failed.content[0].text, /synthetic index rename failure/);
    }
  }, preload);
  await withMcp({ ...env, TEST_MEMDEX_COMMIT: "1" }, async (call) => {
    const failed = await call("upsert_memory", revised);
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /synthetic commit failure/);
  }, preload);

  assert.equal(fs.readFileSync(note, "utf8"), oldNote);
  assert.equal(fs.statSync(note).mtimeMs, oldTimestamp.getTime());
  assert.equal(fs.readFileSync(index, "utf8"), oldIndex);
  assert.deepEqual(fs.readdirSync(path.dirname(index)).sort(), ["MEMORY.md", "ledger.md"]);

  await withMcp(env, async (call) => {
    assert.match(text(await call("read_memory", { id })), /oldbodysignal/);
    assert.match(text(await call("get_memory_index", { workspace })), /oldindexsignal/);
    assert.match(text(await call("search_past_memory", {
      query: "newbodysignal", project: workspace, layer: "notes",
    })), /No past memory found/);
    assert.deepEqual(await onlyCandidate(call), receipt);

    for (let run = 0; run < 2; run++) {
      assert.match(text(await call("upsert_memory", revised)), /Saved L2 memory note/);
    }
    const contents = text(await call("get_memory_index", { workspace }));
    assert.match(contents, /newindexsignal/);
    assert.equal(contents.split(id).length - 1, 1);
    assert.deepEqual(await onlyCandidate(call), receipt);
  });

  const finalDb = initDb(dbPath);
  try {
    assert.equal(finalDb.prepare("SELECT count(*) AS n FROM notes").get().n, 1);
    assert.equal(finalDb.prepare("SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH 'newbodysignal'").get().n, 1);
    const watermark = finalDb.prepare("SELECT dreamed_at, dreamed_msg_count FROM conversations WHERE id = 'fixture-thread'").get();
    assert.deepEqual({ ...watermark }, { dreamed_at: "", dreamed_msg_count: 0 });
    assert.match(fs.readFileSync(note, "utf8"), /newbodysignal/);
  } finally {
    finalDb.close();
  }
});
