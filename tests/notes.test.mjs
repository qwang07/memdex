import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  deleteMemory,
  getIndexFilePath,
  getMemoryIndex,
  GLOBAL_INDEX_MAX_LINES,
  initDb,
  parseNoteMarkdown,
  PROJECT_INDEX_MAX_LINES,
  readMemory,
  searchHybrid,
  searchNotes,
  serializeNoteMarkdown,
  syncNotesFromDisk,
  TOTAL_INDEX_MAX_BYTES,
  TOTAL_INDEX_MAX_LINES,
  upsertConversationRecord,
  upsertMemory,
  workspaceToSlug,
} from "../scripts/harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const MCP_CONFIG_PATH = path.join(PLUGIN_ROOT, "mcp_config.json");

describe("memdex L2 notes & MEMORY.md engine", () => {
  let tmpDir;
  let dbPath;
  let notesDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memdex-l2-test-"));
    dbPath = path.join(tmpDir, "memory.db");
    notesDir = path.join(tmpDir, "notes");
    db = initDb(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips YAML frontmatter markdown and protects against invalid slugs/scopes", () => {
    const md = serializeNoteMarkdown({
      name: "Node.js: 首选技术栈",
      description: "零 C++ 编译依赖 #local-first",
      type: "user",
      scope: "global",
      updated: "2026-11-21T12:00:00Z",
      sources: ["conv-1", "conv-2"],
      content: "优先使用 Node.js 内置 node:sqlite，避免 uv/node-gyp。",
    });
    const parsed = parseNoteMarkdown(md);
    assert.equal(parsed.frontmatter.name, "Node.js: 首选技术栈");
    assert.equal(parsed.frontmatter.description, "零 C++ 编译依赖 #local-first");
    assert.equal(parsed.frontmatter.type, "user");
    assert.equal(parsed.frontmatter.scope, "global");
    assert.deepEqual(parsed.frontmatter.sources, ["conv-1", "conv-2"]);
    assert.ok(parsed.content.includes("node:sqlite"));

    assert.throws(
      () =>
        upsertMemory(db, {
          scope: "project",
          type: "project",
          slug: "no-ws",
          name: "Missing WS",
          description: "desc",
          content: "body",
          notesDir,
        }),
      /workspace/i
    );

    // Path traversal slug is neutralized safely inside global dir
    const saved = upsertMemory(db, {
      scope: "global",
      type: "feedback",
      slug: "../../MEMORY",
      name: "防路径穿越",
      description: "恶意 slug 不能覆盖 MEMORY.md",
      content: "测试安全 slug 处理。",
      notesDir,
    });
    assert.ok(!saved.note.slug.includes(".."));
    assert.notEqual(saved.note.slug.toLowerCase(), "memory");
    assert.ok(saved.note.filePath.startsWith(path.join(notesDir, "global")));
  });

  it("enforces hard caps: global <=50 lines, project <=100 lines, combined <=150 lines & <=8KB", () => {
    const projA = "/Users/dev/projects/proj-alpha";
    const projB = "/Users/dev/projects/proj-beta";

    // Write 60 global notes -> global/MEMORY.md must stay <= 50 lines
    for (let i = 1; i <= 60; i += 1) {
      const day = String(((i - 1) % 28) + 1).padStart(2, "0");
      upsertMemory(db, {
        scope: "global",
        type: "user",
        slug: `global-note-${String(i).padStart(3, "0")}`,
        name: `全局偏好条目 ${i}`,
        description: `这是第 ${i} 条用于验证全局索引硬上限截断的中文描述内容`,
        content: `正文 ${i}`,
        updated: `2026-10-${day}T12:00:00Z`,
        notesDir,
      });
    }

    const globalIdxPath = getIndexFilePath(notesDir, "global");
    const globalLines = fs.readFileSync(globalIdxPath, "utf8").trim().split("\n");
    assert.equal(globalLines.length, GLOBAL_INDEX_MAX_LINES);
    assert.ok(globalLines[globalLines.length - 1].includes("omitted"));

    // Write 115 project notes with verbose CJK descriptions to test BOTH 100-line AND 8KB byte caps
    for (let i = 1; i <= 115; i += 1) {
      const day = String(((i - 1) % 28) + 1).padStart(2, "0");
      upsertMemory(db, {
        scope: "project",
        workspace: projA,
        type: "project",
        slug: `proj-note-${String(i).padStart(3, "0")}`,
        name: `项目架构决策记录编号 ${i}（跨模块约束与接口边界）`,
        description: `这条项目笔记包含较长中文摘要，用于触发八千字节硬上限截断并验证不会截断半个汉字字符 ${i}`,
        content: `项目正文 ${i}`,
        updated: `2026-11-${day}T10:00:00Z`,
        notesDir,
      });
    }

    // Write 1 note in projB to verify strict cross-project isolation
    upsertMemory(db, {
      scope: "project",
      workspace: projB,
      type: "project",
      slug: "beta-secret",
      name: "Beta 专属决策",
      description: "BETA_ONLY_SECRET_MARKER",
      content: "不应出现在 projA 索引中",
      notesDir,
    });

    const projAIdxPath = getIndexFilePath(notesDir, "project", workspaceToSlug(projA));
    const projALines = fs.readFileSync(projAIdxPath, "utf8").trim().split("\n");
    assert.equal(projALines.length, PROJECT_INDEX_MAX_LINES);
    assert.ok(projALines[projALines.length - 1].includes("omitted"));

    // Without workspace: ONLY global (<=50 lines), zero project notes
    const globalOnly = getMemoryIndex({ workspace: "", notesDir });
    assert.equal(globalOnly.empty, false);
    assert.ok(globalOnly.lines <= GLOBAL_INDEX_MAX_LINES);
    assert.ok(globalOnly.bytes <= TOTAL_INDEX_MAX_BYTES);
    assert.ok(!globalOnly.text.includes("proj-note-"));
    assert.ok(!globalOnly.text.includes("BETA_ONLY_SECRET_MARKER"));

    // With projA workspace: global + projA, strictly <=150 lines AND <=8192 UTF-8 bytes, zero projB leakage
    const combined = getMemoryIndex({ workspace: projA, notesDir });
    assert.equal(combined.empty, false);
    assert.equal(combined.truncated, true);
    assert.ok(combined.lines <= TOTAL_INDEX_MAX_LINES, `lines=${combined.lines}`);
    assert.ok(combined.bytes <= TOTAL_INDEX_MAX_BYTES, `bytes=${combined.bytes}`);
    assert.equal(Buffer.byteLength(combined.text, "utf8"), combined.bytes);
    assert.ok(!combined.text.includes("\uFFFD"), "UTF-8 byte truncation must not corrupt multibyte chars");
    assert.ok(!combined.text.includes("BETA_ONLY_SECRET_MARKER"), "must not leak other project notes");
  });

  it("reports index budget level on upsert: ok, near, then over with hidden notes", () => {
    const write = (i, extra = {}) =>
      upsertMemory(db, {
        scope: "global",
        type: "feedback",
        slug: `rule-${String(i).padStart(2, "0")}`,
        name: `Rule ${i}`,
        description: `Short rule ${i}`,
        content: `Body ${i}`,
        updated: `2026-11-01T00:00:${String(i).padStart(2, "0")}Z`,
        notesDir,
        ...extra,
      });

    const first = write(1);
    assert.equal(first.budget.level, "ok");
    assert.equal(first.budget.warning, "");
    assert.equal(first.budget.scopeLines, 2);
    assert.equal(first.budget.scopeMaxLines, GLOBAL_INDEX_MAX_LINES);
    assert.equal(first.budget.hiddenNotes, 0);

    // 40 notes + header = 41/50 lines (82%) -> near
    let last;
    for (let i = 2; i <= 40; i += 1) last = write(i);
    assert.equal(last.budget.level, "near");
    assert.match(last.budget.warning, /Index near budget: global index 41\/50 lines/);
    assert.match(last.budget.warning, /updating an existing note/);

    // Updating an existing slug does not grow the index
    const updated = write(40, { content: "Revised body" });
    assert.equal(updated.budget.scopeLines, 41);

    // 50 notes exceed the 50-line global cap (header + 48 entries + footer) -> over, 2 hidden
    for (let i = 41; i <= 50; i += 1) last = write(i);
    assert.equal(last.budget.level, "over");
    assert.equal(last.budget.scopeOmittedNotes, 2);
    assert.equal(last.budget.hiddenNotes, 2);
    assert.equal(last.budget.totalNotes, 50);
    assert.match(last.budget.warning, /Index over budget: 2 of 50 note\(s\)/);
    assert.match(last.budget.warning, /delete_memory/);
    assert.match(last.budget.warning, /list_memory_notes/);
  });

  it("flags the combined 8KB injection budget for project writes even when scope line caps hold", () => {
    const ws = "/Users/dev/projects/byte-heavy";
    let last;
    for (let i = 1; i <= 60; i += 1) {
      last = upsertMemory(db, {
        scope: "project",
        workspace: ws,
        type: "project",
        slug: `wide-${String(i).padStart(2, "0")}`,
        name: `项目决策 ${i}：跨模块接口边界与长期约束说明`,
        description: `较长的中文描述用于占满字节预算，验证 upsert 返回值会在注入索引超出 8KB 时提醒合并 ${i}`,
        content: `正文 ${i}`,
        notesDir,
      });
    }
    assert.ok(last.budget.scopeLines < PROJECT_INDEX_MAX_LINES, "scope line cap is not the binding limit");
    assert.equal(last.index.truncated, false);
    assert.equal(last.budget.level, "over");
    assert.ok(last.budget.totalBytes <= TOTAL_INDEX_MAX_BYTES);
    assert.ok(last.budget.hiddenNotes > 0);
    assert.equal(last.budget.visibleNotes + last.budget.hiddenNotes, 60);
  });

  it("ships Skill rules for in-conversation writes, dedupe, and budget warnings", () => {
    const skill = fs.readFileSync(path.join(PLUGIN_ROOT, "skills", "memdex", "SKILL.md"), "utf8");
    const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
    assert.match(description, /记住/);
    assert.match(description, /remember/);
    assert.match(description, /correct/);
    assert.match(skill, /# Saving During the Conversation/);
    assert.match(skill, /`upsert_memory` in the same turn/);
    assert.match(skill, /## What not to save/);
    assert.match(skill, /## Update instead of duplicating/);
    assert.match(skill, /same `scope`, `workspace`, and `slug`/);
    assert.match(skill, /\[Budget Warning\]/);
  });

  it("syncs notes_fts on upsert/update/delete, supports disk sync, and runs L2-first hybrid search", () => {
    const ws = "/Users/dev/projects/memdex";
    const now = new Date("2026-11-21T12:00:00Z");

    const created = upsertMemory(db, {
      scope: "project",
      workspace: ws,
      type: "project",
      slug: "storage-decision",
      name: "存储层决策",
      description: "统一迁移到 ~/.memdex 并使用 node:sqlite",
      content: "决定采用纯 Node.js + node:sqlite WAL 与 FTS5 trigram 实现双语检索。",
      sources: ["conv-old-1"],
      updated: "2026-10-01T10:00:00Z",
      notesDir,
      now,
    });

    // Read old note -> staleness warning attached
    const fetched = readMemory(db, created.note.id, { notesDir, now });
    assert.ok(fetched);
    assert.equal(fetched.isStale, true);
    assert.ok(fetched.stalenessNote.includes("51d old"));
    assert.deepEqual(fetched.sources, ["conv-old-1"]);

    // Add L3 conversation with same keyword
    upsertConversationRecord(db, {
      id: "conv-old-1",
      source: "antigravity",
      workspace: ws,
      lastUpdated: "2026-11-20T10:00:00Z",
      messages: [
        {
          stepIndex: 0,
          role: "USER",
          content: "讨论一下双语检索和 node:sqlite 的方案",
          timestamp: "2026-11-20T10:00:00Z",
        },
      ],
    });

    // Hybrid search hits BOTH L2 notes (including 2-char short query) and L3 conversations
    const hybrid = searchHybrid(db, "双语检索", { project: "memdex", now });
    assert.equal(hybrid.notes.length, 1);
    assert.equal(hybrid.notes[0].id, created.note.id);
    assert.equal(hybrid.messages.length, 1);
    assert.equal(hybrid.messages[0].conversationId, "conv-old-1");

    assert.equal(searchNotes(db, "检索").length, 1);

    // Hand-edit markdown on disk and syncNotesFromDisk -> FTS reflects updated text
    const editedMd = fs.readFileSync(created.note.filePath, "utf8").replace("双语检索", "跨工具双语召回");
    fs.writeFileSync(created.note.filePath, editedMd, "utf8");
    const diskStats = syncNotesFromDisk(db, { notesDir });
    assert.equal(diskStats.synced, 1);
    assert.equal(searchNotes(db, "跨工具双语召回").length, 1);

    // Delete removes file, SQLite row, FTS entry, and cleans up empty MEMORY.md
    const delRes = deleteMemory(db, created.note.id, { notesDir });
    assert.equal(delRes.deleted, true);
    assert.equal(fs.existsSync(created.note.filePath), false);
    assert.equal(fs.existsSync(getIndexFilePath(notesDir, "project", workspaceToSlug(ws))), false);
    assert.equal(readMemory(db, created.note.id, { notesDir }), null);
    assert.equal(searchNotes(db, "跨工具双语召回").length, 0);
    assert.equal(getMemoryIndex({ workspace: ws, notesDir }).empty, true);
  });

  it("serves L2 CRUD, MEMORY.md disclosure, staleness warnings, and L2-first hybrid search over MCP stdio", async () => {
    const ws = "/Users/dev/projects/retinue";
    upsertConversationRecord(db, {
      id: "conv-retinue-1",
      source: "retinue",
      workspace: ws,
      lastUpdated: "2026-11-21T08:00:00Z",
      messages: [
        {
          stepIndex: 0,
          role: "USER",
          content: "Retinue 打算通过标准 Hook 接入 memdex 全局记忆",
          timestamp: "2026-11-21T08:00:00Z",
        },
      ],
    });

    const mcpConfig = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8"));
    const serverCfg = mcpConfig.mcpServers.memdex;

    const child = spawn(process.execPath, serverCfg.args, {
      cwd: tmpDir,
      env: {
        ...process.env,
        PLUGIN_ROOT,
        MEMDEX_DB: dbPath,
        MEMDEX_NOTES_DIR: notesDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const pending = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const resolver = pending.shift();
        if (resolver) resolver(msg);
      }
    });

    const nextMessage = () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP timeout. stderr=${stderr}`)), 5000);
        pending.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });

    const callTool = async (id, name, args) => {
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n"
      );
      const resp = await nextMessage();
      assert.equal(resp.id, id);
      return resp.result;
    };

    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "l2-test-client", version: "0.2.0" },
          },
        }) + "\n"
      );
      await nextMessage();
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      // 1. Empty index initially
      const emptyIdx = await callTool(2, "get_memory_index", { workspace: ws });
      assert.ok(emptyIdx.content[0].text.includes("No distilled L2 memory notes"));

      // 2. Upsert a global note and an old (>30d) project note
      const upGlobal = await callTool(3, "upsert_memory", {
        scope: "global",
        type: "user",
        slug: "js-preference",
        name: "语言偏好",
        description: "熟悉 JavaScript / Node.js 生态",
        content: "优先选用纯 Node.js ESM 实现，减少原生编译依赖。",
      });
      assert.ok(upGlobal.content[0].text.includes("global/js-preference"));
      assert.match(upGlobal.content[0].text, /- Budget: global index 2\/50 lines/);
      assert.ok(!upGlobal.content[0].text.includes("[Budget Warning]"));

      const upProj = await callTool(4, "upsert_memory", {
        scope: "project",
        workspace: ws,
        type: "project",
        slug: "retinue-hook-contract",
        name: "Retinue Hook 接入契约",
        description: "通过 memdex hook session-start --host plain 与 memdex ingest 接入",
        content: "Retinue 计划使用标准 JSON Hook 接入 memdex。",
        sources: ["conv-retinue-1"],
        updated: "2026-09-15T10:00:00Z",
      });
      const projNoteId = `projects/${workspaceToSlug(ws)}/retinue-hook-contract`;
      assert.ok(upProj.content[0].text.includes(projNoteId));

      // 3. get_memory_index: global-only vs global+project
      const idxGlobal = await callTool(5, "get_memory_index", {});
      assert.ok(idxGlobal.content[0].text.includes("global/js-preference"));
      assert.ok(!idxGlobal.content[0].text.includes("retinue-hook-contract"));

      const idxProject = await callTool(6, "get_memory_index", { workspace: ws });
      assert.ok(idxProject.content[0].text.includes("global/js-preference"));
      assert.ok(idxProject.content[0].text.includes(projNoteId));

      // 4. read_memory returns full body, provenance, and [Stale Warning] on old note
      const readRes = await callTool(7, "read_memory", { id: projNoteId });
      const readText = readRes.content[0].text;
      assert.ok(readText.includes("Retinue 计划使用标准 JSON Hook"));
      assert.ok(readText.includes("conv-retinue-1"));
      assert.ok(readText.includes("[Stale Warning]"));

      // 5. L2-first hybrid search_past_memory returns L2 section BEFORE L3 section
      const searchRes = await callTool(8, "search_past_memory", { query: "Retinue" });
      const searchText = searchRes.content[0].text;
      const l2Pos = searchText.indexOf("## Distilled Notes (L2)");
      const l3Pos = searchText.indexOf("## Conversation Matches (L3)");
      assert.ok(l2Pos !== -1, "must contain L2 section");
      assert.ok(l3Pos !== -1, "must contain L3 section");
      assert.ok(l2Pos < l3Pos, "L2 distilled notes must appear before L3 raw conversation matches");

      // 6. delete_memory removes note from disk, index, and notes_fts
      const delRes = await callTool(9, "delete_memory", { id: projNoteId });
      assert.ok(delRes.content[0].text.includes("Deleted L2 memory note"));
      assert.ok(delRes.content[0].text.includes("MEMORY.md removed"));

      const readAfterDel = await callTool(10, "read_memory", { id: projNoteId });
      assert.ok(readAfterDel.content[0].text.includes("not found"));

      const searchAfterDel = await callTool(11, "search_past_memory", {
        query: "Retinue",
        layer: "notes",
      });
      assert.ok(searchAfterDel.content[0].text.includes("No past memory found"));

      // 7. upsert_memory warns the model to merge notes once the global index hides entries
      for (let i = 1; i <= GLOBAL_INDEX_MAX_LINES; i += 1) {
        upsertMemory(db, {
          scope: "global",
          type: "feedback",
          slug: `seed-${String(i).padStart(2, "0")}`,
          name: `Seed ${i}`,
          description: `Seeded rule ${i}`,
          content: `Rule ${i}`,
          updated: "2026-10-01T00:00:00Z",
          notesDir,
        });
      }
      const overBudget = await callTool(12, "upsert_memory", {
        scope: "global",
        type: "feedback",
        slug: "reply-language",
        name: "Reply language",
        description: "Reply in Chinese",
        content: "Reply in Chinese.",
      });
      const overText = overBudget.content[0].text;
      assert.ok(overText.includes("Saved L2 memory note `global/reply-language`"));
      assert.ok(overText.includes("[Budget Warning] Index over budget"));
      assert.ok(overText.includes("delete_memory"));
    } finally {
      child.kill();
    }
  });
});
