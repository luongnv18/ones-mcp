import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OnesApiError } from '../client/errors.js';
import { parseOnesReference } from '../client/url-parser.js';
import { resolveTeamUUID, toolJson, withToolErrors, type ToolContext } from './helpers.js';

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'ones_project_list',
    {
      description: 'List ONES projects accessible to the current user.',
      inputSchema: z.object({
        query: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
        teamUUID: z.string().optional()
      })
    },
    async ({ query, limit, offset, teamUUID }) =>
      withToolErrors(async () => {
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID);
        const projects = await ctx.project.listProjects({
          teamUUID: resolvedTeam,
          query,
          limit,
          offset
        });
        return toolJson({ teamUUID: resolvedTeam, count: projects.length, projects });
      })
  );

  server.registerTool(
    'ones_project_get_metadata',
    {
      description:
        'Get project configuration metadata: issue types, statuses, priorities, sprints, members, and custom fields.',
      inputSchema: z.object({
        projectOrUrl: z.string().describe('Project UUID or ONES project URL.'),
        teamUUID: z.string().optional()
      })
    },
    async ({ projectOrUrl, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(projectOrUrl, 'project');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.projectUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine projectUUID.');
        }
        const meta = await ctx.project.getProjectMetadata({
          teamUUID: resolvedTeam,
          projectUUID: ref.projectUUID
        });
        return toolJson(meta);
      })
  );
}
