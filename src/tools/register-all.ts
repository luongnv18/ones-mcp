import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './helpers.js';
import { registerAuthTools } from './auth.tools.js';
import { registerWikiTools } from './wiki.tools.js';
import { registerProjectTools } from './project.tools.js';
import { registerIssueTools } from './issue.tools.js';
import { registerWorklogTools } from './worklog.tools.js';
import { registerAttachmentTools } from './attachment.tools.js';

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerAuthTools(server, ctx);
  registerWikiTools(server, ctx);
  registerProjectTools(server, ctx);
  registerIssueTools(server, ctx);
  registerWorklogTools(server, ctx);
  registerAttachmentTools(server, ctx);
}
