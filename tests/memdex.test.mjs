import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  getConversationMessages,
  initDb,
  searchMessages,
  syncConversation,
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
    assert.equal(messages.length, 2);
    assert.ok(!messages[0].content.includes("ADDITIONAL_METADATA"));

    assert.equal(searchMessages(db, "TOOL_DUMP_SECRET_NOISE_XYZ_99999").length, 0);
    assert.equal(searchMessages(db, "全局记忆").length, 1);
    assert.equal(searchMessages(db, "记忆").length, 1);
    assert.equal(searchMessages(db, "js").length, 1);
    assert.equal(searchMessages(db, "memdex 插件").length, 1);
    assert.equal(searchMessages(db, "trigram", { project: "demo-app" }).length, 1);
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

    // Conversation with only GENERIC tool paths and no workspace in USER_INPUT stays Global / No Workspace
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
    assert.equal(convNoWs.workspace, "Global / No Workspace");
  });

  it("skips unchanged files and incrementally re-indexes appended transcripts", () => {
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
    const { messages } = getConversationMessages(db, "conv-inc-003");
    assert.equal(messages.length, 2);
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
  });

  it("boots via mcp_config.json with PLUGIN_ROOT from any cwd and serves MCP tools over stdio", async () => {
    const logFile = createTranscript("conv-mcp-005", [
      {
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-21T10:00:00Z",
        content: "<USER_REQUEST>\n如何排查 Redis 连接池耗尽的问题？\n</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T10:00:15Z",
        content: "检查 max_connections 并确保异常分支释放连接。",
      },
    ]);

    syncConversation(db, "conv-mcp-005", logFile, {
      workspaceHint: "/Users/dev/projects/backend",
    });

    const mcpConfig = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8"));
    const serverCfg = mcpConfig.mcpServers.memdex;

    // Launch from tmpDir (different cwd) to verify PLUGIN_ROOT bootstrap works anywhere
    const child = spawn(process.execPath, serverCfg.args, {
      cwd: tmpDir,
      env: {
        ...process.env,
        PLUGIN_ROOT,
        MEMDEX_DB: dbPath,
        MEMDEX_BRAIN_DIRS: brainDir,
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
          clientInfo: { name: "test-client", version: "0.1.0" },
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
        new Set(["search_past_memory", "get_conversation_detail", "list_recent_conversations", "sync_memory_now"])
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
      assert.ok(searchText.includes("Redis"));

      send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_conversation_detail", arguments: { conversation_id: "conv-mcp-005" } },
      });
      const detailResp = await nextMessage();
      assert.ok(detailResp.result.content[0].text.includes("max_connections"));
    } finally {
      child.kill();
    }
  });
});
