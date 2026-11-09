import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolJson, withToolErrors, type ToolContext } from './helpers.js';

export function registerAuthTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'ones_auth_status',
    {
      description: 'Check current ONES authentication session, active teamUUID, and token expiry.',
      inputSchema: z.object({})
    },
    async () =>
      withToolErrors(async () => {
        const session = ctx.refreshManager.getCurrentSession();
        if (!session) {
          return toolJson({
            authenticated: false,
            baseUrl: ctx.config.baseUrl,
            message: 'Not logged in. Call `ones_login` or run `ones-mcp login` in your terminal.'
          });
        }
        const now = Date.now();
        const expiresInSeconds =
          session.expiresAt !== undefined ? Math.round((session.expiresAt - now) / 1000) : null;
        return toolJson({
          authenticated: true,
          baseUrl: session.baseUrl,
          teamUUID: session.teamUUID ?? ctx.config.defaultTeamUUID ?? null,
          userUUID: session.userUUID ?? null,
          userEmail: session.userEmail ?? null,
          hasRefreshToken: Boolean(session.refreshToken),
          expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
          expiresInSeconds
        });
      })
  );

  server.registerTool(
    'ones_login',
    {
      description:
        'Open a browser window to ONES so the user can sign in with password + Microsoft Authenticator OTP and capture a fresh Bearer session.',
      inputSchema: z.object({
        baseUrl: z
          .string()
          .url()
          .optional()
          .describe('Optional ONES base URL to log into (defaults to configured ONES_BASE_URL).'),
        timeoutSeconds: z
          .number()
          .int()
          .min(30)
          .max(600)
          .default(300)
          .describe('Maximum seconds to wait for user 2FA login in browser.')
      })
    },
    async ({ baseUrl, timeoutSeconds }) =>
      withToolErrors(async () => {
        const session = await (baseUrl
          ? ctx.triggerInteractiveLogin(timeoutSeconds * 1000, baseUrl)
          : ctx.triggerInteractiveLogin(timeoutSeconds * 1000));
        return toolJson({
          authenticated: true,
          baseUrl: session.baseUrl,
          teamUUID: session.teamUUID ?? null,
          userEmail: session.userEmail ?? null,
          expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null
        });
      })
  );
}
