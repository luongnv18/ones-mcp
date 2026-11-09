#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOnesMcpServer } from './server.js';

async function main() {
  const { server, ctx } = createOnesMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  ctx.logger.info('ONES MCP Server running on stdio', { baseUrl: ctx.config.baseUrl });
}

main().catch((err) => {
  process.stderr.write(`Fatal MCP server error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
