/**
 * Compatibility entrypoint for Memdex MCP stdio server.
 * Delegates to the unified MCP server implementation in `src/mcp.mjs`.
 */

import { startMcpServer } from "../src/mcp.mjs";

await startMcpServer();
