import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OnesApiError } from '../client/errors.js';
import { parseOnesReference } from '../client/url-parser.js';
import { resolveTeamUUID, toolJson, withToolErrors, type ToolContext } from './helpers.js';

export function registerIssueTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'ones_issue_search',
    {
      description: 'Search and filter ONES issues by project, keyword, status, assignee, sprint, or type.',
      inputSchema: z.object({
        projectOrUrl: z.string().optional(),
        query: z.string().optional(),
        status: z.string().optional(),
        assigneeUUID: z.string().optional(),
        sprintUUID: z.string().optional(),
        issueType: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
        teamUUID: z.string().optional()
      })
    },
    async ({ projectOrUrl, query, status, assigneeUUID, sprintUUID, issueType, limit, offset, teamUUID }) =>
      withToolErrors(async () => {
        const ref = projectOrUrl ? parseOnesReference(projectOrUrl, 'project') : undefined;
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref?.teamUUID);
        const issues = await ctx.issue.searchIssues({
          teamUUID: resolvedTeam,
          projectUUID: ref?.projectUUID,
          query,
          status,
          assigneeUUID,
          sprintUUID,
          issueType,
          limit,
          offset
        });
        return toolJson({ teamUUID: resolvedTeam, count: issues.length, issues });
      })
  );

  server.registerTool(
    'ones_issue_get',
    {
      description: 'Get full details of an ONES issue including description, fields, transitions, and comments.',
      inputSchema: z.object({
        issueOrUrl: z.string().describe('Issue UUID or full ONES issue URL.'),
        teamUUID: z.string().optional()
      })
    },
    async ({ issueOrUrl, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(issueOrUrl, 'issue');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.issueUUID) {
          throw new OnesApiError(
            'VALIDATION_ERROR',
            'Provide issueUUID or full issue URL. To search by issue number, use ones_issue_search.'
          );
        }
        const issue = await ctx.issue.getIssue({
          teamUUID: resolvedTeam,
          issueUUID: ref.issueUUID
        });
        return toolJson(issue);
      })
  );

  server.registerTool(
    'ones_issue_create',
    {
      description: 'Create a new ONES issue or subtask.',
      inputSchema: z.object({
        projectOrUrl: z.string().describe('Project UUID or full project URL.'),
        issueType: z.string().min(1).describe('Issue type UUID or name from project metadata.'),
        summary: z.string().min(1),
        descriptionMarkdown: z.string().optional(),
        assigneeUUID: z.string().optional(),
        priority: z.string().optional(),
        sprintUUID: z.string().optional(),
        parentIssueUUID: z.string().optional(),
        customFields: z.record(z.string(), z.unknown()).optional(),
        teamUUID: z.string().optional()
      })
    },
    async ({
      projectOrUrl,
      issueType,
      summary,
      descriptionMarkdown,
      assigneeUUID,
      priority,
      sprintUUID,
      parentIssueUUID,
      customFields,
      teamUUID
    }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(projectOrUrl, 'project');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.projectUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine projectUUID.');
        }
        const created = await ctx.issue.createIssue({
          teamUUID: resolvedTeam,
          projectUUID: ref.projectUUID,
          issueType,
          summary,
          descriptionMarkdown,
          assigneeUUID,
          priority,
          sprintUUID,
          parentIssueUUID,
          customFields
        });
        return toolJson(created);
      })
  );

  server.registerTool(
    'ones_issue_update',
    {
      description: 'Update fields on an existing ONES issue.',
      inputSchema: z.object({
        issueOrUrl: z.string(),
        summary: z.string().optional(),
        descriptionMarkdown: z.string().optional(),
        assigneeUUID: z.string().optional(),
        priority: z.string().optional(),
        sprintUUID: z.string().optional(),
        customFields: z.record(z.string(), z.unknown()).optional(),
        teamUUID: z.string().optional()
      })
    },
    async ({
      issueOrUrl,
      summary,
      descriptionMarkdown,
      assigneeUUID,
      priority,
      sprintUUID,
      customFields,
      teamUUID
    }) =>
      withToolErrors(async () => {
        if (
          summary === undefined &&
          descriptionMarkdown === undefined &&
          assigneeUUID === undefined &&
          priority === undefined &&
          sprintUUID === undefined &&
          customFields === undefined
        ) {
          throw new OnesApiError(
            'VALIDATION_ERROR',
            'Provide at least one field to update (summary, descriptionMarkdown, assigneeUUID, priority, sprintUUID, or customFields).'
          );
        }
        const ref = parseOnesReference(issueOrUrl, 'issue');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.issueUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine issueUUID.');
        }
        const updated = await ctx.issue.updateIssue({
          teamUUID: resolvedTeam,
          issueUUID: ref.issueUUID,
          summary,
          descriptionMarkdown,
          assigneeUUID,
          priority,
          sprintUUID,
          customFields
        });
        return toolJson(updated);
      })
  );

  server.registerTool(
    'ones_issue_transition',
    {
      description: 'Transition an ONES issue workflow status by target status name or transitionUUID.',
      inputSchema: z.object({
        issueOrUrl: z.string(),
        targetStatus: z.string().min(1),
        teamUUID: z.string().optional()
      })
    },
    async ({ issueOrUrl, targetStatus, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(issueOrUrl, 'issue');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.issueUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine issueUUID.');
        }
        const result = await ctx.issue.transitionIssue({
          teamUUID: resolvedTeam,
          issueUUID: ref.issueUUID,
          targetStatus
        });
        return toolJson(result);
      })
  );

  server.registerTool(
    'ones_issue_list_comments',
    {
      description: 'List comments on an ONES issue.',
      inputSchema: z.object({
        issueOrUrl: z.string(),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
        teamUUID: z.string().optional()
      })
    },
    async ({ issueOrUrl, limit, offset, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(issueOrUrl, 'issue');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.issueUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine issueUUID.');
        }
        const comments = await ctx.issue.listComments({
          teamUUID: resolvedTeam,
          issueUUID: ref.issueUUID,
          limit,
          offset
        });
        return toolJson({ issueUUID: ref.issueUUID, count: comments.length, comments });
      })
  );

  server.registerTool(
    'ones_issue_add_comment',
    {
      description: 'Add a comment (or reply) to an ONES issue.',
      inputSchema: z.object({
        issueOrUrl: z.string(),
        content: z.string().min(1),
        replyToCommentUUID: z.string().optional(),
        teamUUID: z.string().optional()
      })
    },
    async ({ issueOrUrl, content, replyToCommentUUID, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(issueOrUrl, 'issue');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.issueUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine issueUUID.');
        }
        const added = await ctx.issue.addComment({
          teamUUID: resolvedTeam,
          issueUUID: ref.issueUUID,
          content,
          replyToCommentUUID
        });
        return toolJson(added);
      })
  );

  server.registerTool(
    'ones_issue_update_comment',
    {
      description: 'Update an existing comment on an ONES issue.',
      inputSchema: z.object({
        issueOrUrl: z.string(),
        commentUUID: z.string().min(1),
        content: z.string().min(1),
        teamUUID: z.string().optional()
      })
    },
    async ({ issueOrUrl, commentUUID, content, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(issueOrUrl, 'issue');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.issueUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine issueUUID.');
        }
        const updated = await ctx.issue.updateComment({
          teamUUID: resolvedTeam,
          issueUUID: ref.issueUUID,
          commentUUID,
          content
        });
        return toolJson(updated);
      })
  );
}
