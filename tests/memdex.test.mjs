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
  DEFAULT_RECENT_DEMOTE_MINUTES,
  DEFAULT_WORKSPACE,
  getConversationMessages,
  GLOBAL_SLUG,
  initDb,
  isSubsessionPrompt,
  listConversations,
  migrateLegacyDbIfNeeded,
  normalizeWorkspace,
  resolveDbPath,
  resolveMemdexHome,
  resolveNotesDir,
  SCHEMA_VERSION,
  searchHybrid,
  searchMessages,
  syncConversation,
  upsertConversationRecord,
  upsertMemory,
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

  it("supports tail reading, offset pagination, and exact range metadata in getConversationMessages", () => {
    const messages = [];
    for (let i = 0; i < 50; i += 1) {
      messages.push({
        stepIndex: i,
        role: i % 2 === 0 ? "USER" : "AI",
        content: `Message #${i + 1}`,
        timestamp: new Date(Date.parse("2026-11-20T10:00:00Z") + i * 1000).toISOString(),
      });
    }
    upsertConversationRecord(db, {
      id: "conv-long-50",
      source: "claude_archive",
      workspace: "/Users/dev/projects/long-session",
      lastUpdated: "2026-11-20T10:01:00Z",
      messages,
    });

    // Default head page: 1-20 of 50
    const head = getConversationMessages(db, "conv-long-50", { maxMessages: 20 });
    assert.equal(head.messages.length, 20);
    assert.equal(head.messages[0].content, "Message #1");
    assert.equal(head.messages[19].content, "Message #20");
    assert.deepEqual(head.page, {
      total: 50,
      offset: 0,
      limit: 20,
      tail: false,
      start: 1,
      end: 20,
      hasMoreBefore: false,
      hasMoreAfter: true,
    });

    // Forward offset page: 21-40 of 50
    const mid = getConversationMessages(db, "conv-long-50", { maxMessages: 20, offset: 20 });
    assert.equal(mid.messages[0].content, "Message #21");
    assert.equal(mid.messages[19].content, "Message #40");
    assert.equal(mid.page.start, 21);
    assert.equal(mid.page.end, 40);
    assert.equal(mid.page.hasMoreBefore, true);
    assert.equal(mid.page.hasMoreAfter, true);

    // Tail read: 36-50 of 50, still ordered chronologically (ASC)
    const tail1 = getConversationMessages(db, "conv-long-50", { maxMessages: 15, tail: true });
    assert.equal(tail1.messages.length, 15);
    assert.equal(tail1.messages[0].content, "Message #36");
    assert.equal(tail1.messages[14].content, "Message #50");
    assert.deepEqual(tail1.page, {
      total: 50,
      offset: 0,
      limit: 15,
      tail: true,
      start: 36,
      end: 50,
      hasMoreBefore: true,
      hasMoreAfter: false,
    });

    // Tail read with offset=15 -> 21-35 of 50 in chronological order
    const tail2 = getConversationMessages(db, "conv-long-50", { maxMessages: 15, tail: true, offset: 15 });
    assert.equal(tail2.messages[0].content, "Message #21");
    assert.equal(tail2.messages[14].content, "Message #35");
    assert.equal(tail2.page.start, 21);
    assert.equal(tail2.page.end, 35);
    assert.equal(tail2.page.hasMoreBefore, true);
    assert.equal(tail2.page.hasMoreAfter, true);

    // Tail read reaching start of conversation -> 1-5 of 50
    const tailStart = getConversationMessages(db, "conv-long-50", { maxMessages: 15, tail: true, offset: 45 });
    assert.equal(tailStart.messages.length, 5);
    assert.equal(tailStart.messages[0].content, "Message #1");
    assert.equal(tailStart.messages[4].content, "Message #5");
    assert.equal(tailStart.page.start, 1);
    assert.equal(tailStart.page.end, 5);
    assert.equal(tailStart.page.hasMoreBefore, false);
    assert.equal(tailStart.page.hasMoreAfter, true);

    // Out-of-range offset returns empty safely
    const empty = getConversationMessages(db, "conv-long-50", { maxMessages: 10, offset: 60 });
    assert.equal(empty.messages.length, 0);
    assert.equal(empty.page.start, 0);
    assert.equal(empty.page.end, 0);
  });

  it("losslessly upgrades a v5 database to v6, backfills sub-sessions, and filters listConversations", () => {
    assert.equal(isSubsessionPrompt("Background (from the session that started this one): run checks"), true);
    assert.equal(isSubsessionPrompt("  Task (from the session that spawned this): audit"), true);
    assert.equal(isSubsessionPrompt("<task-notification>done</task-notification>"), true);
    assert.equal(isSubsessionPrompt("[Subagent] inspect logs"), true);
    assert.equal(isSubsessionPrompt("梳理一下下一个目标"), false);
    assert.equal(isSubsessionPrompt("/plan 优化 memdex"), false);

    const v5Path = path.join(tmpDir, "v5-upgrade.db");
    const notesDir = path.join(tmpDir, "v5-notes");
    const seeded = new DatabaseSync(v5Path);
    seeded.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'antigravity',
        workspace TEXT NOT NULL,
        workspace_slug TEXT NOT NULL DEFAULT 'global',
        last_updated TEXT NOT NULL,
        source_path TEXT NOT NULL DEFAULT '',
        file_mtime REAL NOT NULL DEFAULT 0,
        file_size INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        dreamed_at TEXT NOT NULL DEFAULT '',
        dreamed_msg_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        step_index INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      PRAGMA user_version = 5;
    `);
    const insConv = seeded.prepare(
      "INSERT INTO conversations (id, source, workspace, workspace_slug, last_updated, message_count, dreamed_at, dreamed_msg_count) VALUES (?, 'claude_archive', '/Users/dev/projects/retinue', 'retinue-12345678', ?, 1, ?, ?)"
    );
    const insMsg = seeded.prepare(
      "INSERT INTO messages (conversation_id, step_index, role, content, timestamp) VALUES (?, 0, 'USER', ?, ?)"
    );
    insConv.run("v5-main", "2026-11-15T10:00:00Z", "2026-11-16T00:00:00Z", 1);
    insMsg.run("v5-main", "梳理一下下一个目标", "2026-11-15T10:00:00Z");
    insConv.run("v5-bg", "2026-11-15T11:00:00Z", "", 0);
    insMsg.run("v5-bg", "Background (from the session that started this one): 项目 retinue", "2026-11-15T11:00:00Z");
    insConv.run("v5-task", "2026-11-15T12:00:00Z", "", 0);
    insMsg.run("v5-task", "Task (from the session that started this one): 检查测试", "2026-11-15T12:00:00Z");
    seeded.close();

    const upgraded = initDb(v5Path, { autoMigrate: false });
    try {
      assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
      upsertMemory(upgraded, {
        scope: "project",
        workspace: "/Users/dev/projects/retinue",
        type: "project",
        slug: "keep-note",
        name: "Keep",
        description: "Preserved note",
        content: "Preserved body",
        notesDir,
      });

      const flags = Object.fromEntries(
        upgraded.prepare("SELECT id, is_subsession, dreamed_at, dreamed_msg_count FROM conversations").all().map((r) => [r.id, r])
      );
      assert.equal(flags["v5-main"].is_subsession, 0);
      assert.equal(flags["v5-main"].dreamed_at, "2026-11-16T00:00:00Z");
      assert.equal(flags["v5-main"].dreamed_msg_count, 1);
      assert.equal(flags["v5-bg"].is_subsession, 1);
      assert.equal(flags["v5-task"].is_subsession, 1);

      const mainOnly = listConversations(upgraded, { limit: 10 });
      assert.deepEqual(mainOnly.map((c) => c.conversationId), ["v5-main"]);
      assert.equal(mainOnly[0].isSubsession, false);

      const withSubs = listConversations(upgraded, { limit: 10, includeSubsessions: true });
      assert.deepEqual(withSubs.map((c) => c.conversationId), ["v5-task", "v5-bg", "v5-main"]);
      assert.equal(withSubs[0].isSubsession, true);
      assert.equal(withSubs[1].isSubsession, true);
      assert.equal(withSubs[2].isSubsession, false);
    } finally {
      upgraded.close();
    }
  });

  it("soft-demotes very recent conversations when excludeConversationId is omitted without hiding them when slots remain", () => {
    assert.equal(DEFAULT_RECENT_DEMOTE_MINUTES, 10);
    const now = new Date("2026-11-25T10:00:00Z");
    const ws = "/Users/dev/projects/alpha";

    // Active conversation updated 2 minutes ago with 3 exact matches
    upsertConversationRecord(db, {
      id: "conv-active",
      source: "antigravity",
      workspace: ws,
      lastUpdated: "2026-11-25T09:58:00Z",
      messages: [
        { stepIndex: 0, role: "USER", content: "量子路由缓存策略怎么设计？量子路由缓存策略", timestamp: "2026-11-25T09:55:00Z" },
        { stepIndex: 1, role: "AI", content: "量子路由缓存策略采用双层 LRU 量子路由缓存策略", timestamp: "2026-11-25T09:57:00Z" },
        { stepIndex: 2, role: "AI", content: "再次确认量子路由缓存策略细节", timestamp: "2026-11-25T09:58:00Z" },
      ],
    });
    // Another active window updated 3 minutes ago
    upsertConversationRecord(db, {
      id: "conv-other-window",
      source: "codex",
      workspace: ws,
      lastUpdated: "2026-11-25T09:57:00Z",
      messages: [
        { stepIndex: 0, role: "AI", content: "另一个窗口刚讨论了量子路由缓存策略的超时阈值", timestamp: "2026-11-25T09:57:00Z" },
      ],
    });
    // Older past conversation (2 days ago) with 2 matches
    upsertConversationRecord(db, {
      id: "conv-past",
      source: "claude_archive",
      workspace: ws,
      lastUpdated: "2026-11-23T10:00:00Z",
      messages: [
        { stepIndex: 0, role: "USER", content: "旧会话：讨论量子路由缓存策略", timestamp: "2026-11-23T09:59:00Z" },
        { stepIndex: 1, role: "AI", content: "旧结论：量子路由缓存策略默认 TTL 60s", timestamp: "2026-11-23T10:00:00Z" },
      ],
    });

    // 1. Without excludeConversationId, limit=2 -> older past matches fill both slots, active matches demoted.
    const demoted = searchHybrid(db, "量子路由缓存策略", { project: ws, limit: 2, now });
    assert.deepEqual(demoted.messages.map((m) => m.conversationId), ["conv-past", "conv-past"]);
    assert.ok(demoted.messages.every((m) => m.possiblyActive === false));
    assert.equal(demoted.demotedRecentCount, 4);

    // 2. When limit > older matches (limit=4), older matches come first and remaining slots keep recent matches tagged possiblyActive.
    const mixed = searchHybrid(db, "量子路由缓存策略", { project: ws, limit: 4, now });
    assert.deepEqual(mixed.messages.slice(0, 2).map((m) => m.conversationId), ["conv-past", "conv-past"]);
    assert.ok(mixed.messages.slice(2).every((m) => m.possiblyActive === true));
    assert.equal(mixed.demotedRecentCount, 2);

    // 3. When ONLY recent matches exist, they are still returned (zero false negatives).
    const onlyRecent = searchHybrid(db, "超时阈值", { project: ws, limit: 5, now });
    assert.equal(onlyRecent.messages.length, 1);
    assert.equal(onlyRecent.messages[0].conversationId, "conv-other-window");
    assert.equal(onlyRecent.messages[0].possiblyActive, true);
    assert.equal(onlyRecent.demotedRecentCount, 0);

    // 4. When excludeConversationId is passed for conv-active, demotion defaults to 0 so conv-other-window is NOT demoted/tagged.
    const excludedSelf = searchHybrid(db, "量子路由缓存策略", {
      project: ws,
      excludeConversationId: "conv-active",
      limit: 5,
      now,
    });
    assert.ok(excludedSelf.messages.every((m) => m.conversationId !== "conv-active"));
    const otherHit = excludedSelf.messages.find((m) => m.conversationId === "conv-other-window");
    assert.ok(otherHit);
    assert.equal(otherHit.possiblyActive, false);
    assert.equal(excludedSelf.demotedRecentCount, 0);

    // 5. Explicitly setting demoteRecentMinutes=0 disables demotion even without excludeConversationId.
    const noDemote = searchHybrid(db, "量子路由缓存策略", {
      project: ws,
      demoteRecentMinutes: 0,
      limit: 2,
      now,
    });
    assert.equal(noDemote.demotedRecentCount, 0);
    assert.ok(noDemote.messages.every((m) => m.possiblyActive === false));
    assert.ok(noDemote.messages.some((m) => m.conversationId === "conv-active"));
  });

  it("exposes tail/offset pagination, sub-session filtering, and active-session demotion over MCP stdio", async () => {
    const nowIso = new Date().toISOString();
    const oldIso = "2026-10-01T10:00:00Z";
    const longMsgs = Array.from({ length: 30 }, (_, i) => ({
      stepIndex: i,
      role: i % 2 === 0 ? "USER" : "AI",
      content: `MCP_TURN_${i + 1} 星空协议`,
      timestamp: oldIso,
    }));
    upsertConversationRecord(db, {
      id: "mcp-long",
      source: "claude_archive",
      workspace: "/Users/dev/projects/mcp-ux",
      lastUpdated: oldIso,
      messages: longMsgs,
    });
    upsertConversationRecord(db, {
      id: "mcp-sub-only",
      source: "claude_archive",
      workspace: "/Users/dev/projects/sub-only-proj",
      lastUpdated: oldIso,
      messages: [
        { stepIndex: 0, role: "USER", content: "Background (from the session that started this one): 星空协议子任务", timestamp: oldIso },
      ],
    });
    upsertConversationRecord(db, {
      id: "mcp-active-now",
      source: "antigravity",
      workspace: "/Users/dev/projects/mcp-ux",
      lastUpdated: nowIso,
      messages: [
        { stepIndex: 0, role: "USER", content: "刚才的星空协议星空协议讨论", timestamp: nowIso },
      ],
    });

    const mcpConfig = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8"));
    const serverCfg = mcpConfig.mcpServers.memdex;
    const child = spawn(process.execPath, serverCfg.args, {
      cwd: tmpDir,
      env: {
        ...process.env,
        PLUGIN_ROOT,
        MEMDEX_HOME: tmpDir,
        MEMDEX_DB: dbPath,
        MEMDEX_BRAIN_DIRS: brainDir,
        MEMDEX_CODEX_DIRS: "",
        MEMDEX_CLAUDE_DIRS: "",
        MEMDEX_GEMINI_DIRS: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
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
        const resolver = pending.shift();
        if (resolver) resolver(JSON.parse(line));
      }
    });
    const nextMessage = () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("MCP timeout")), 5000);
        pending.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    let nextId = 1;
    const rpc = async (method, params = {}) => {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return nextMessage();
    };

    try {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ux-test", version: "0.2.0" },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      // 1. get_conversation_detail tail=true + offset
      const tailRes = await rpc("tools/call", {
        name: "get_conversation_detail",
        arguments: { conversation_id: "mcp-long", max_messages: 5, tail: true },
      });
      const tailText = tailRes.result.content[0].text;
      assert.match(tailText, /Showing messages 26–30 of 30/);
      assert.match(tailText, /25 earlier message\(s\) not shown/);
      assert.ok(tailText.indexOf("MCP_TURN_26") < tailText.indexOf("MCP_TURN_30"));

      const prevRes = await rpc("tools/call", {
        name: "get_conversation_detail",
        arguments: { conversation_id: "mcp-long", max_messages: 5, tail: true, offset: 5 },
      });
      const prevText = prevRes.result.content[0].text;
      assert.match(prevText, /Showing messages 21–25 of 30/);
      assert.match(prevText, /20 earlier message\(s\), 5 later message\(s\) not shown/);

      // 2. list_recent_conversations hides sub-session by default & reports hidden count on sub-only project
      const listDefault = (await rpc("tools/call", {
        name: "list_recent_conversations",
        arguments: { limit: 10 },
      })).result.content[0].text;
      assert.ok(listDefault.includes("mcp-long"));
      assert.ok(!listDefault.includes("mcp-sub-only"));

      const listSubOnly = (await rpc("tools/call", {
        name: "list_recent_conversations",
        arguments: { project: "sub-only-proj" },
      })).result.content[0].text;
      assert.match(listSubOnly, /1 sub-session\(s\) hidden/);

      const listWithSubs = (await rpc("tools/call", {
        name: "list_recent_conversations",
        arguments: { project: "sub-only-proj", include_subsessions: true },
      })).result.content[0].text;
      assert.ok(listWithSubs.includes("mcp-sub-only"));
      assert.ok(listWithSubs.includes("[subsession]"));

      // 3. search_past_memory soft-demotes active session & shows note; demote_recent_minutes=0 restores it
      const searchDemoted = (await rpc("tools/call", {
        name: "search_past_memory",
        arguments: { query: "星空协议", project: "mcp-ux", limit: 2 },
      })).result.content[0].text;
      assert.ok(searchDemoted.includes("mcp-long"));
      assert.ok(!searchDemoted.includes("mcp-active-now"));
      assert.match(searchDemoted, /deprioritized behind older matches/);

      const searchSubBadge = (await rpc("tools/call", {
        name: "search_past_memory",
        arguments: { query: "星空协议子任务" },
      })).result.content[0].text;
      assert.ok(searchSubBadge.includes("mcp-sub-only"));
      assert.ok(searchSubBadge.includes("[subsession]"));

      const searchNoDemote = (await rpc("tools/call", {
        name: "search_past_memory",
        arguments: { query: "星空协议", project: "mcp-ux", limit: 2, demote_recent_minutes: 0 },
      })).result.content[0].text;
      assert.ok(searchNoDemote.includes("mcp-active-now"));
    } finally {
      child.kill();
    }
  });
});
