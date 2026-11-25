import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  computeStaleness,
  DEFAULT_WORKSPACE,
  getConversationMessages,
  GLOBAL_SLUG,
  initDb,
  listConversations,
  migrateLegacyDbIfNeeded,
  normalizeWorkspace,
  resolveDbPath,
  resolveMemdexHome,
  resolveNotesDir,
  SCHEMA_VERSION,
  searchMessages,
  syncConversation,
  upsertConversationRecord,
  workspaceToSlug,
} from "../scripts/harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const HARNESS_PATH = path.join(PLUGIN_ROOT, "scripts", "harness.mjs");
const MCP_CONFIG_PATH = path.join(PLUGIN_ROOT, "mcp_config.json");

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("memdex", () => {
  let tmpDir;
  let dbPath;
  let brainDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memdex-test-"));
    dbPath = path.join(tmpDir, "memory.db");
    brainDir = path.join(tmpDir, "brain");
    db = initDb(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTranscript(convId, records, filename = "transcript.jsonl") {
    const logFile = path.join(brainDir, convId, ".system_generated", "logs", filename);
    writeJsonl(logFile, records);
    return logFile;
  }

  it("supports Chinese/English hybrid search and excludes GENERIC tool dumps", () => {
    const logFile = createTranscript("conv-cn-001", [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content:
          "<USER_REQUEST>\n帮我给 antigravity 配置 memdex 全局记忆插件，用 js 和 node:sqlite 实现\n</USER_REQUEST>\n" +
          "<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-20\n</ADDITIONAL_METADATA>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "GENERIC",
        created_at: "2026-11-20T10:00:05Z",
        content: "TOOL_DUMP_SECRET_NOISE_XYZ_99999 " + "x".repeat(5000),
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:00:10Z",
        content: "我们改用 SQLite FTS5 trigram 分词支持中文检索，并关闭了 PreInvocation 自动注入。",
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:00:12Z",
        content: "   ",
      },
    ]);

    const status = syncConversation(db, "conv-cn-001", logFile, {
      workspaceHint: "/Users/dev/projects/demo-app",
    });
    assert.equal(status, "updated");

    const { conversation, messages } = getConversationMessages(db, "conv-cn-001");
    assert.ok(conversation);
    assert.equal(conversation.workspace, "/Users/dev/projects/demo-app");
    assert.equal(conversation.source, "antigravity");
    assert.match(conversation.workspaceSlug, /^demo-app-[a-f0-9]{8}$/);
    assert.equal(messages.length, 2);
    assert.ok(!messages[0].content.includes("ADDITIONAL_METADATA"));

    assert.equal(searchMessages(db, "TOOL_DUMP_SECRET_NOISE_XYZ_99999").length, 0);
    assert.equal(searchMessages(db, "全局记忆").length, 1);
    assert.equal(searchMessages(db, "记忆").length, 1);
    assert.equal(searchMessages(db, "js").length, 1);
    assert.equal(searchMessages(db, "memdex 插件").length, 1);
    assert.equal(searchMessages(db, "trigram", { project: "demo-app" }).length, 1);
    assert.equal(searchMessages(db, "trigram", { project: conversation.workspaceSlug }).length, 1);
    assert.equal(searchMessages(db, "trigram", { project: "other-proj" }).length, 0);
  });

  it("extracts POSIX workspace paths from USER_INPUT while ignoring GENERIC dumps and dot-dirs", () => {
    const logFile = createTranscript("conv-mac-002", [
      {
        step_index: 0,
        source: "MODEL",
        type: "GENERIC",
        created_at: "2026-11-20T11:00:00Z",
        content:
          "# comment: C:\\path\\to\\workspace -> CorpusName\n" +
          "lrwxr-xr-x /Users/dev/.bun/bin/codegraph -> ../lib/codegraph\n" +
          "Active Document: /Users/dev/.gemini/antigravity/builtin/skills/plugin/SKILL.md (read)",
      },
      {
        step_index: 1,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T11:00:05Z",
        content: "CWD: /Users/dev/projects/my-service\n排查一下数据库连接超时",
      },
    ]);

    syncConversation(db, "conv-mac-002", logFile);
    const { conversation } = getConversationMessages(db, "conv-mac-002");
    assert.equal(conversation.workspace, "/Users/dev/projects/my-service");

    const logFileNoWs = createTranscript("conv-mac-002b", [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T11:05:00Z",
        content: "<USER_REQUEST>\n随便聊聊架构设计\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "GENERIC",
        created_at: "2026-11-20T11:05:05Z",
        content: "C:\\path\\to\\workspace -> CorpusName\n/Users/dev/.bun/bin/tool -> /opt/tool",
      },
    ]);
    syncConversation(db, "conv-mac-002b", logFileNoWs);
    const { conversation: convNoWs } = getConversationMessages(db, "conv-mac-002b");
    assert.equal(convNoWs.workspace, DEFAULT_WORKSPACE);
    assert.equal(convNoWs.workspaceSlug, GLOBAL_SLUG);
  });

  it("infers project root workspace from structured tool_calls while ignoring home dot-dirs", () => {
    // Use a real directory outside /tmp (under tmpDir? Note /tmp is ignored, so test non-existent /Users/dev/... AND real git root via temp dir under home or non-/tmp path!)
    const nonExistentRepo = "/Users/dev/Documents/Projects/acme-api";
    const homeDir = os.homedir();
    const logFile = createTranscript("conv-toolcalls-001", [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-21T08:00:00Z",
        content: "<USER_REQUEST>\n先熟悉一下项目进展\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T08:00:02Z",
        content: "",
        tool_calls: [
          { name: "read_file", args: { Path: JSON.stringify(path.join(homeDir, ".agents", ".skill-lock.json")) } },
          { name: "read_file", args: { Path: JSON.stringify(path.join(homeDir, ".gemini", "config", "config.json")) } },
          { name: "read_file", args: { Path: JSON.stringify(`${nonExistentRepo}/package.json`) } },
          { name: "read_file", args: { Path: JSON.stringify(`${nonExistentRepo}/src/server.mjs`) } },
          { name: "read_file", args: { Path: JSON.stringify(`${nonExistentRepo}/routes/health/index.mjs`) } },
        ],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T08:00:10Z",
        content: "已完成项目结构梳理。",
      },
    ]);

    syncConversation(db, "conv-toolcalls-001", logFile);
    const { conversation } = getConversationMessages(db, "conv-toolcalls-001");
    assert.equal(conversation.workspace, nonExistentRepo);
    assert.match(conversation.workspaceSlug, /^acme-api-[a-f0-9]{8}$/);

    // Also test real on-disk git repo resolution (this repo itself!)
    const logFileRealRepo = createTranscript("conv-toolcalls-002", [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-21T08:10:00Z",
        content: "<USER_REQUEST>\n检查 harness 代码\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T08:10:02Z",
        content: "",
        tool_calls: [
          { name: "read_file", args: { Path: JSON.stringify(path.join(PLUGIN_ROOT, "scripts", "harness.mjs")) } },
          { name: "read_file", args: { Path: JSON.stringify(path.join(PLUGIN_ROOT, "src", "paths.mjs")) } },
        ],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T08:10:08Z",
        content: "已检查。",
      },
    ]);

    syncConversation(db, "conv-toolcalls-002", logFileRealRepo);
    const { conversation: realConv } = getConversationMessages(db, "conv-toolcalls-002");
    assert.equal(realConv.workspace, normalizeWorkspace(PLUGIN_ROOT));
  });

  it("resolves ~/.memdex default home, MEMDEX_HOME override, and MEMDEX_DB priority", () => {
    const fakeHome = path.join(tmpDir, "fake-home");
    const customMemdexHome = path.join(tmpDir, "custom-memdex");
    const explicitDb = path.join(tmpDir, "explicit.db");

    withEnv({ HOME: fakeHome, MEMDEX_HOME: undefined, MEMDEX_DB: undefined }, () => {
      assert.equal(resolveMemdexHome(), path.join(fakeHome, ".memdex"));
      assert.equal(resolveDbPath(), path.join(fakeHome, ".memdex", "memory.db"));
      assert.equal(resolveNotesDir(), path.join(fakeHome, ".memdex", "notes"));
    });

    withEnv({ HOME: fakeHome, MEMDEX_HOME: customMemdexHome, MEMDEX_DB: undefined }, () => {
      assert.equal(resolveMemdexHome(), path.resolve(customMemdexHome));
      assert.equal(resolveDbPath(), path.join(path.resolve(customMemdexHome), "memory.db"));
      assert.equal(resolveNotesDir(), path.join(path.resolve(customMemdexHome), "notes"));
    });

    withEnv({ HOME: fakeHome, MEMDEX_HOME: customMemdexHome, MEMDEX_DB: explicitDb }, () => {
      assert.equal(resolveDbPath(), path.resolve(explicitDb));
    });
  });

  it("normalizes symlinked workspaces via realpath into one canonical workspace and collision-free slug", () => {
    const realRepo = path.join(tmpDir, "real-projects", "my-repo");
    const linkParent = path.join(tmpDir, "links");
    const symlinkRepo = path.join(linkParent, "my-repo-link");
    fs.mkdirSync(realRepo, { recursive: true });
    fs.mkdirSync(linkParent, { recursive: true });
    fs.symlinkSync(realRepo, symlinkRepo);

    const canonicalA = normalizeWorkspace(realRepo);
    const canonicalB = normalizeWorkspace(`${symlinkRepo}/`);
    assert.equal(canonicalA, canonicalB);
    assert.equal(workspaceToSlug(realRepo), workspaceToSlug(symlinkRepo));
    assert.match(workspaceToSlug(realRepo), /^my-repo-[a-f0-9]{8}$/);

    // Same basename in different folders -> distinct slugs
    const slugOne = workspaceToSlug("/Users/dev/org-a/app");
    const slugTwo = workspaceToSlug("/Users/dev/org-b/app");
    assert.notEqual(slugOne, slugTwo);
    assert.ok(slugOne.startsWith("app-"));
    assert.ok(slugTwo.startsWith("app-"));

    assert.equal(workspaceToSlug(DEFAULT_WORKSPACE), GLOBAL_SLUG);
  });

  it("migrates legacy WAL data/memory.db non-destructively and upgrades v2 schema to v3", () => {
    const legacyDbPath = path.join(tmpDir, "legacy-data", "memory.db");
    fs.mkdirSync(path.dirname(legacyDbPath), { recursive: true });

    // Create a genuine v2 database (without source, workspace_slug, dreamed_at, dreamed_msg_count) in WAL mode
    const legacy = new DatabaseSync(legacyDbPath);
    legacy.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        last_updated TEXT NOT NULL,
        source_path TEXT NOT NULL DEFAULT '',
        file_mtime REAL NOT NULL DEFAULT 0,
        file_size INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        step_index INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      PRAGMA user_version = 2;
    `);
    legacy
      .prepare(
        "INSERT INTO conversations (id, workspace, last_updated, source_path, file_mtime, file_size, message_count) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run("legacy-conv-1", DEFAULT_WORKSPACE, "2026-11-10T10:00:00Z", "/fake/path.jsonl", 123456, 500, 1);
    legacy
      .prepare(
        "INSERT INTO conversations (id, workspace, last_updated, source_path, file_mtime, file_size, message_count) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run("legacy-conv-2", "/Users/dev/projects/foo/", "2026-11-12T10:00:00Z", "/fake/path2.jsonl", 123456, 500, 1);
    legacy
      .prepare(
        "INSERT INTO messages (conversation_id, step_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)"
      )
      .run("legacy-conv-1", 0, "USER", "旧库里的历史对话内容", "2026-11-10T10:00:00Z");
    legacy.close();

    const targetDbPath = path.join(tmpDir, "new-home", "memory.db");
    const firstMig = migrateLegacyDbIfNeeded(targetDbPath, legacyDbPath);
    assert.equal(firstMig.migrated, true);
    assert.ok(fs.existsSync(legacyDbPath), "legacy DB must be preserved untouched");

    // Second migration call must be a no-op when target exists
    const secondMig = migrateLegacyDbIfNeeded(targetDbPath, legacyDbPath);
    assert.equal(secondMig.migrated, false);
    assert.equal(secondMig.reason, "target-exists");

    // Open migrated DB through initDb -> upgrades v2 -> v3
    const upgraded = initDb(targetDbPath, { autoMigrate: false });
    try {
      const userVer = upgraded.prepare("PRAGMA user_version").get().user_version;
      assert.equal(userVer, SCHEMA_VERSION);

      const c1 = upgraded.prepare("SELECT * FROM conversations WHERE id = ?").get("legacy-conv-1");
      assert.equal(c1.source, "antigravity");
      assert.equal(c1.workspace_slug, GLOBAL_SLUG);
      assert.equal(c1.dreamed_at, "");
      assert.equal(c1.dreamed_msg_count, 0);
      assert.equal(c1.file_mtime, 0, "legacy Global row mtime reset so next sync backfills real workspace");

      const c2 = upgraded.prepare("SELECT * FROM conversations WHERE id = ?").get("legacy-conv-2");
      assert.equal(c2.workspace, "/Users/dev/projects/foo");
      assert.match(c2.workspace_slug, /^foo-[a-f0-9]{8}$/);
      assert.equal(c2.file_mtime, 123456, "non-Global row keeps mtime");
    } finally {
      upgraded.close();
    }
  });

  it("skips unchanged files, incrementally re-indexes, and preserves dreamed_at watermark on update", () => {
    const logFile = createTranscript("conv-inc-003", [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-20T12:00:00Z",
        content: "第一次提问关于部署脚本",
      },
    ]);

    assert.equal(syncConversation(db, "conv-inc-003", logFile), "updated");
    assert.equal(syncConversation(db, "conv-inc-003", logFile), "skipped");

    // Simulate a previous Dream pass marking this conversation dreamed at 1 message
    db.prepare("UPDATE conversations SET dreamed_at = ?, dreamed_msg_count = ? WHERE id = ?").run(
      "2026-11-20T13:00:00Z",
      1,
      "conv-inc-003"
    );

    fs.appendFileSync(
      logFile,
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T12:01:00Z",
        content: "部署脚本已经通过验收测试",
      }) + "\n",
      "utf8"
    );

    assert.equal(syncConversation(db, "conv-inc-003", logFile), "updated");
    const { conversation, messages } = getConversationMessages(db, "conv-inc-003");
    assert.equal(messages.length, 2);
    assert.equal(conversation.dreamedAt, "2026-11-20T13:00:00Z");
    assert.equal(conversation.dreamedMsgCount, 1);
  });

  it("computes staleness warnings, filters by source, and excludes specified conversationId", () => {
    const now = new Date("2026-11-21T12:00:00Z");

    const fresh = computeStaleness("2026-11-21T08:00:00Z", { now });
    assert.equal(fresh.ageDays, 0);
    assert.equal(fresh.ageLabel, "today");
    assert.equal(fresh.isStale, false);
    assert.equal(fresh.stalenessNote, "");

    const mid = computeStaleness("2026-11-05T12:00:00Z", { now });
    assert.equal(mid.ageDays, 16);
    assert.equal(mid.ageLabel, "16d ago");
    assert.equal(mid.isStale, true);
    assert.ok(mid.stalenessNote.includes("16d old"));

    const old = computeStaleness("2026-10-01T12:00:00Z", { now });
    assert.equal(old.ageDays, 51);
    assert.equal(old.isStale, true);
    assert.ok(old.stalenessNote.includes("code/git"));

    upsertConversationRecord(db, {
      id: "conv-fresh-codex",
      source: "codex",
      workspace: "/Users/dev/projects/alpha",
      lastUpdated: "2026-11-21T10:00:00Z",
      messages: [
        { stepIndex: 0, role: "USER", content: "缓存淘汰策略改成 LRU", timestamp: "2026-11-21T10:00:00Z" },
      ],
    });
    upsertConversationRecord(db, {
      id: "conv-old-agy",
      source: "antigravity",
      workspace: "/Users/dev/projects/alpha",
      lastUpdated: "2026-10-10T10:00:00Z",
      messages: [
        { stepIndex: 0, role: "AI", content: "缓存淘汰策略最初使用 FIFO", timestamp: "2026-10-10T10:00:00Z" },
      ],
    });

    const allHits = searchMessages(db, "缓存淘汰策略", { now });
    assert.equal(allHits.length, 2);

    const onlyCodex = searchMessages(db, "缓存淘汰策略", { source: "codex", now });
    assert.equal(onlyCodex.length, 1);
    assert.equal(onlyCodex[0].conversationId, "conv-fresh-codex");
    assert.equal(onlyCodex[0].isStale, false);

    const excluded = searchMessages(db, "缓存淘汰策略", {
      excludeConversationId: "conv-fresh-codex",
      now,
    });
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0].conversationId, "conv-old-agy");
    assert.equal(excluded[0].isStale, true);
    assert.ok(excluded[0].stalenessNote.includes("42d old"));

    const codexList = listConversations(db, { source: "codex", now });
    assert.equal(codexList.length, 1);
    assert.equal(codexList[0].source, "codex");
  });

  it("satisfies Antigravity Stop hook stdin/stdout JSON contract", () => {
    const logFile = createTranscript("conv-hook-004", [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-21T09:00:00Z",
        content: "<USER_REQUEST>\n测试 Stop Hook 增量入库\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T09:00:05Z",
        content: "已验证 Stop Hook 返回合法 JSON。",
      },
    ]);

    const payload = {
      conversationId: "conv-hook-004",
      transcriptPath: logFile,
      workspacePaths: ["/Users/dev/projects/hook-test"],
      terminationReason: "NO_TOOL_CALL",
    };

    const res = spawnSync(process.execPath, [HARNESS_PATH, "--hook"], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, MEMDEX_DB: dbPath },
    });

    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "{}");

    const results = searchMessages(db, "增量入库");
    assert.equal(results.length, 1);
    assert.equal(results[0].workspace, "/Users/dev/projects/hook-test");
    assert.equal(results[0].source, "antigravity");
  });

  it("syncs Codex and Antigravity and preserves source filters and staleness over MCP stdio", async () => {
    const logFile = createTranscript("conv-mcp-005", [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-09-01T10:00:00Z",
        content: "<USER_REQUEST>\n如何排查 Redis 连接池耗尽的问题？\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-09-01T10:00:15Z",
        content: "检查 max_connections 并确保异常分支释放连接。",
      },
    ]);

    syncConversation(db, "conv-mcp-005", logFile, {
      workspaceHint: "/Users/dev/projects/backend",
    });

    const mcpConfig = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8"));
    const serverCfg = mcpConfig.mcpServers.memdex;

    const codexHome = path.join(tmpDir, "codex-home");
    const sessions = path.join(codexHome, "sessions", "2025", "10", "07");
    fs.mkdirSync(sessions, { recursive: true });
    fs.copyFileSync(
      path.join(PLUGIN_ROOT, "tests", "fixtures", "codex-l3", "rollout-live.jsonl"),
      path.join(sessions, "rollout-synthetic.jsonl")
    );
    const env = {
      ...process.env,
      PLUGIN_ROOT,
      MEMDEX_HOME: tmpDir,
      MEMDEX_DB: dbPath,
      MEMDEX_BRAIN_DIRS: brainDir,
      CODEX_HOME: codexHome,
      MEMDEX_CLAUDE_DIRS: "",
      MEMDEX_GEMINI_DIRS: "",
    };
    delete env.MEMDEX_CODEX_DIRS;

    const child = spawn(process.execPath, serverCfg.args, {
      cwd: tmpDir,
      env,
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

    const send = (msg) => {
      child.stdin.write(JSON.stringify(msg) + "\n");
    };

    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.2.0" },
        },
      });
      const initResp = await nextMessage();
      assert.equal(initResp.id, 1);
      assert.ok(initResp.result);

      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const listResp = await nextMessage();
      const names = new Set(listResp.result.tools.map((t) => t.name));
      assert.deepEqual(
        names,
        new Set([
          "get_memory_index",
          "read_memory",
          "upsert_memory",
          "delete_memory",
          "search_past_memory",
          "get_conversation_detail",
          "list_recent_conversations",
          "sync_memory_now",
          "get_dream_candidates",
          "mark_dreamed",
          "list_memory_notes",
        ])
      );

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_past_memory", arguments: { query: "连接池耗尽" } },
      });
      const searchResp = await nextMessage();
      const searchText = searchResp.result.content[0].text;
      assert.ok(searchText.includes("conv-mcp-005"));
      assert.ok(searchText.includes("antigravity"));
      assert.ok(searchText.includes("[Stale Warning]"));

      send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "search_past_memory",
          arguments: { query: "连接池耗尽", exclude_conversation_id: "conv-mcp-005" },
        },
      });
      const excludedResp = await nextMessage();
      assert.ok(excludedResp.result.content[0].text.includes("No past memory found"));

      send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "get_conversation_detail", arguments: { conversation_id: "conv-mcp-005" } },
      });
      const detailResp = await nextMessage();
      const detailText = detailResp.result.content[0].text;
      assert.ok(detailText.includes("max_connections"));
      assert.ok(detailText.includes("[Stale Warning]"));

      send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "sync_memory_now", arguments: {} },
      });
      const syncResp = await nextMessage();
      assert.doesNotMatch(syncResp.result.content[0].text, /Error:/);
      assert.match(syncResp.result.content[0].text, /Updated: 1 \| Skipped: 1/);

      send({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "search_past_memory", arguments: { query: "aurora ledger", source: "codex" } },
      });
      const codexResp = await nextMessage();
      assert.match(codexResp.result.content[0].text, /codex:11111111-1111-4111-8111-111111111111/);
      assert.match(codexResp.result.content[0].text, /CODEX-LIVE-DECISION/);
    } finally {
      child.kill();
    }
  });
});
