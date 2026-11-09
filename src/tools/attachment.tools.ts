import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OnesApiError } from '../client/errors.js';
import { parseOnesReference } from '../client/url-parser.js';
import { resolveTeamUUID, toolJson, withToolErrors, type ToolContext } from './helpers.js';

function extractTeamFromFileUrl(fileUrl?: string): string | undefined {
  if (!fileUrl) return undefined;
  const match = fileUrl.match(/\/team\/([^/#?]+)/);
  return match?.[1];
}

function resolveAttachmentTeamUUID(
  ctx: ToolContext,
  teamUUID?: string,
  fileUrl?: string
): string {
  if (fileUrl) {
    return (
      teamUUID?.trim() ||
      extractTeamFromFileUrl(fileUrl) ||
      ctx.refreshManager.getCurrentSession()?.teamUUID ||
      ctx.config.defaultTeamUUID ||
      ''
    );
  }
  return resolveTeamUUID(ctx, teamUUID);
}

export function registerAttachmentTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'ones_attachment_list',
    {
      description: 'List attachments on an ONES issue or Wiki page.',
      inputSchema: z.object({
        targetType: z.enum(['issue', 'wiki']),
        targetOrUrl: z.string(),
        teamUUID: z.string().optional()
      })
    },
    async ({ targetType, targetOrUrl, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(targetOrUrl, targetType);
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        const targetUUID = targetType === 'wiki' ? ref.pageUUID : ref.issueUUID;
        if (!targetUUID) {
          throw new OnesApiError('VALIDATION_ERROR', `Could not resolve ${targetType} UUID.`);
        }
        const attachments = await ctx.attachment.listAttachments({
          teamUUID: resolvedTeam,
          targetType,
          targetUUID
        });
        return toolJson({ targetType, targetUUID, count: attachments.length, attachments });
      })
  );

  server.registerTool(
    'ones_attachment_read',
    {
      description:
        'Download and extract readable text/Markdown from attached documents (.txt, .md, .csv, .json, .pdf, .docx, .xlsx) or return image content (.png, .jpg, .webp).',
      inputSchema: z.object({
        attachmentUUID: z.string().optional(),
        fileUrl: z.string().optional(),
        targetType: z.enum(['issue', 'wiki']).optional(),
        maxChars: z.number().int().min(500).max(200000).default(50000),
        teamUUID: z.string().optional()
      })
    },
    async ({ attachmentUUID, fileUrl, targetType, maxChars, teamUUID }) =>
      withToolErrors(async () => {
        const resolvedTeam = resolveAttachmentTeamUUID(ctx, teamUUID, fileUrl);
        const res = await ctx.attachment.readAttachment({
          teamUUID: resolvedTeam,
          attachmentUUID,
          fileUrl,
          targetType,
          maxChars
        });
        if (res.kind === 'image') {
          return {
            content: [{ type: 'image' as const, data: res.base64, mimeType: res.mimeType }]
          };
        }
        return toolJson(res);
      })
  );

  server.registerTool(
    'ones_attachment_download',
    {
      description: 'Download an ONES attachment to a local file path.',
      inputSchema: z.object({
        attachmentUUID: z.string().optional(),
        fileUrl: z.string().optional(),
        targetType: z.enum(['issue', 'wiki']).optional(),
        outputPath: z.string().min(1),
        teamUUID: z.string().optional()
      })
    },
    async ({ attachmentUUID, fileUrl, targetType, outputPath, teamUUID }) =>
      withToolErrors(async () => {
        const resolvedTeam = resolveAttachmentTeamUUID(ctx, teamUUID, fileUrl);
        const saved = await ctx.attachment.downloadAttachment({
          teamUUID: resolvedTeam,
          attachmentUUID,
          fileUrl,
          targetType,
          outputPath
        });
        return toolJson(saved);
      })
  );

  server.registerTool(
    'ones_attachment_upload',
    {
      description: 'Upload a local file as an attachment to an ONES issue or Wiki page.',
      inputSchema: z.object({
        targetType: z.enum(['issue', 'wiki']),
        targetOrUrl: z.string(),
        filePath: z.string().min(1),
        teamUUID: z.string().optional()
      })
    },
    async ({ targetType, targetOrUrl, filePath, teamUUID }) =>
      withToolErrors(async () => {
        const ref = parseOnesReference(targetOrUrl, targetType);
        const resolvedTeam = resolveTeamUUID(ctx, teamUUID, ref.teamUUID);
        const targetUUID = targetType === 'wiki' ? ref.pageUUID : ref.issueUUID;
        if (!targetUUID) {
          throw new OnesApiError('VALIDATION_ERROR', `Could not resolve ${targetType} UUID.`);
        }
        const uploaded = await ctx.attachment.uploadAttachment({
          teamUUID: resolvedTeam,
          targetType,
          targetUUID,
          filePath
        });
        return toolJson(uploaded);
      })
  );
}
