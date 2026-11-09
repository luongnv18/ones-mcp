import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OnesApiError } from '../client/errors.js';
import { parseOnesReference } from '../client/url-parser.js';
import { resolveTeamUUID, toolJson, withToolErrors, type ToolContext } from './helpers.js';

export function registerWorklogTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'ones_worklog_list',
    {
      description: 'List recorded worklogs (manhours) on an ONES issue.',
      inputSchema: z.object({
        issueOrUrl: z.string(),
        teamUUID: z.string().optional()
      })
    },
    async ({ issueOrUrl, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(issueOrUrl, 'issue');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.issueUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine issueUUID.');
        }
        const worklogs = await ctx.worklog.listWorklogs({
          teamUUID: resolvedTeam,
          issueUUID: ref.issueUUID
        });
        return toolJson({ issueUUID: ref.issueUUID, count: worklogs.length, worklogs });
      })
  );

  server.registerTool(
    'ones_worklog_add',
    {
      description: 'Log work hours on an ONES issue.',
      inputSchema: z.object({
        issueOrUrl: z.string(),
        hours: z.number().positive().max(240),
        startDate: z.string().optional().describe('Optional ISO date/datetime, e.g. 2026-11-08'),
        description: z.string().optional(),
        teamUUID: z.string().optional()
      })
    },
    async ({ issueOrUrl, hours, startDate, description, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(issueOrUrl, 'issue');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.issueUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine issueUUID.');
        }
        const added = await ctx.worklog.addWorklog({
          teamUUID: resolvedTeam,
          issueUUID: ref.issueUUID,
          hours,
          startDate,
          description
        });
        return toolJson(added);
      })
  );
}
