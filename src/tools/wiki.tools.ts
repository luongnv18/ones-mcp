import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OnesApiError } from '../client/errors.js';
import { parseOnesReference } from '../client/url-parser.js';
import { resolveTeamUUID, toolJson, withToolErrors, type ToolContext } from './helpers.js';

export function registerWikiTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'ones_wiki_list_spaces',
    {
      description: 'List ONES Wiki spaces accessible to the current user.',
      inputSchema: z.object({
        teamUUID: z.string().optional().describe('Optional team UUID; defaults to logged-in team.'),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0)
      })
    },
    async ({ teamUUID, limit, offset }) =>
      withToolErrors(async () => {
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID);
        const spaces = await ctx.wiki.listSpaces({ teamUUID: resolvedTeam, limit, offset });
        return toolJson({ teamUUID: resolvedTeam, count: spaces.length, spaces });
      })
  );

  server.registerTool(
    'ones_wiki_get_page_tree',
    {
      description: 'Get hierarchical Wiki page tree for a space or beneath a specific parent page.',
      inputSchema: z.object({
        spaceOrUrl: z.string().describe('Space UUID or full ONES Wiki Space/Page URL.'),
        parentPageUUID: z.string().optional().describe('Optional parent page UUID to scope the tree.'),
        maxDepth: z.number().int().min(1).max(10).default(3),
        teamUUID: z.string().optional()
      })
    },
    async ({ spaceOrUrl, parentPageUUID, maxDepth, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(spaceOrUrl, 'space');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        const spaceUUID = ref.spaceUUID;
        if (!spaceUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine spaceUUID from spaceOrUrl.');
        }
        const tree = await ctx.wiki.getPageTree({
          teamUUID: resolvedTeam,
          spaceUUID,
          parentPageUUID: parentPageUUID ?? ref.pageUUID,
          maxDepth
        });
        return toolJson({ teamUUID: resolvedTeam, spaceUUID, tree });
      })
  );

  server.registerTool(
    'ones_wiki_search',
    {
      description: 'Search ONES Wiki pages by keyword.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Search keyword.'),
        spaceUUID: z.string().optional().describe('Optional space UUID filter.'),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
        teamUUID: z.string().optional()
      })
    },
    async ({ query, spaceUUID, limit, offset, teamUUID }) =>
      withToolErrors(async () => {
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID);
        const results = await ctx.wiki.searchPages({
          teamUUID: resolvedTeam,
          query,
          spaceUUID,
          limit,
          offset
        });
        return toolJson({ teamUUID: resolvedTeam, count: results.length, results });
      })
  );

  server.registerTool(
    'ones_wiki_get_page',
    {
      description:
        'Read an ONES Wiki page (or uploaded Wiki file) as clean Markdown, including its direct child pages list. Set includeChildren=true to also read child pages up to safe depth/count limits.',
      inputSchema: z.object({
        pageOrUrl: z.string().describe('Page UUID or full ONES Wiki page URL.'),
        format: z.enum(['markdown', 'raw']).default('markdown'),
        includeChildren: z.boolean().default(false),
        maxDepth: z.number().int().min(1).max(3).default(1),
        maxPages: z.number().int().min(1).max(25).default(10),
        maxTotalChars: z.number().int().min(1000).max(200000).default(60000),
        teamUUID: z.string().optional()
      })
    },
    async ({ pageOrUrl, format, includeChildren, maxDepth, maxPages, maxTotalChars, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(pageOrUrl, 'wiki');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.pageUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine pageUUID from pageOrUrl.');
        }
        const page = await ctx.wiki.getPage({
          teamUUID: resolvedTeam,
          spaceUUID: ref.spaceUUID,
          pageUUID: ref.pageUUID,
          format,
          includeChildren,
          maxDepth,
          maxPages,
          maxTotalChars
        });
        return toolJson(page);
      })
  );

  server.registerTool(
    'ones_wiki_create_page',
    {
      description: 'Create a new ONES Wiki page from Markdown inside a space or under a parent page.',
      inputSchema: z.object({
        spaceOrUrl: z
          .string()
          .optional()
          .describe('Space UUID or Space URL (required unless parentPageOrUrl is a full URL with spaceUUID).'),
        parentPageOrUrl: z.string().optional().describe('Optional parent page UUID or full Wiki URL.'),
        title: z.string().min(1),
        markdown: z.string(),
        teamUUID: z.string().optional()
      })
    },
    async ({ spaceOrUrl, parentPageOrUrl, title, markdown, teamUUID }) =>
      withToolErrors(async () => {
        const spaceRef = spaceOrUrl ? parseOnesReference(spaceOrUrl, 'space') : undefined;
        const parentRef = parentPageOrUrl ? parseOnesReference(parentPageOrUrl, 'wiki') : undefined;
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, parentRef?.teamUUID ?? spaceRef?.teamUUID);
        const resolvedSpace = spaceRef?.spaceUUID ?? parentRef?.spaceUUID;
        if (!resolvedSpace && !parentRef?.pageUUID) {
          throw new OnesApiError(
            'VALIDATION_ERROR',
            'Provide spaceOrUrl or a parentPageOrUrl containing spaceUUID/pageUUID.'
          );
        }
        const created = await ctx.wiki.createPage({
          teamUUID: resolvedTeam,
          spaceUUID: resolvedSpace,
          parentPageUUID: parentRef?.pageUUID,
          title,
          markdown
        });
        return toolJson(created);
      })
  );

  server.registerTool(
    'ones_wiki_update_page',
    {
      description:
        'Safely update an ONES Wiki page title and/or content from Markdown (reads current page first, checks lock state, supports replace or append).',
      inputSchema: z.object({
        pageOrUrl: z.string().describe('Page UUID or full ONES Wiki page URL.'),
        title: z.string().optional(),
        markdown: z.string().optional(),
        mode: z.enum(['replace', 'append']).default('replace'),
        teamUUID: z.string().optional()
      })
    },
    async ({ pageOrUrl, title, markdown, mode, teamUUID }) =>
      withToolErrors(async () => {
        if (title === undefined && markdown === undefined) {
          throw new OnesApiError('VALIDATION_ERROR', 'Provide at least title or markdown to update.');
        }
        const ref = parseOnesReference(pageOrUrl, 'wiki');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.pageUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine pageUUID from pageOrUrl.');
        }
        const updated = await ctx.wiki.updatePage({
          teamUUID: resolvedTeam,
          pageUUID: ref.pageUUID,
          title,
          markdown,
          mode
        });
        return toolJson(updated);
      })
  );

  server.registerTool(
    'ones_wiki_list_comments',
    {
      description: 'List comments on an ONES Wiki page.',
      inputSchema: z.object({
        pageOrUrl: z.string(),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
        teamUUID: z.string().optional()
      })
    },
    async ({ pageOrUrl, limit, offset, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(pageOrUrl, 'wiki');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.pageUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine pageUUID from pageOrUrl.');
        }
        const comments = await ctx.wiki.listComments({
          teamUUID: resolvedTeam,
          pageUUID: ref.pageUUID,
          limit,
          offset
        });
        return toolJson({ pageUUID: ref.pageUUID, count: comments.length, comments });
      })
  );

  server.registerTool(
    'ones_wiki_add_comment',
    {
      description: 'Add a comment to an ONES Wiki page.',
      inputSchema: z.object({
        pageOrUrl: z.string(),
        content: z.string().min(1),
        teamUUID: z.string().optional()
      })
    },
    async ({ pageOrUrl, content, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(pageOrUrl, 'wiki');
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        if (!ref.pageUUID) {
          throw new OnesApiError('VALIDATION_ERROR', 'Could not determine pageUUID from pageOrUrl.');
        }
        const added = await ctx.wiki.addComment({
          teamUUID: resolvedTeam,
          pageUUID: ref.pageUUID,
          content
        });
        return toolJson(added);
      })
  );
}
