import type { OnesConfig } from '../config/env.js';
import type { Logger } from '../client/logger.js';
import { OnesApiError, formatMcpError } from '../client/errors.js';
import type { RefreshManager } from '../auth/refresh-manager.js';
import type { TokenStore, AuthSession } from '../auth/token-store.js';
import type { WikiAdapter } from '../client/adapters/wiki.adapter.js';
import type { ProjectAdapter } from '../client/adapters/project.adapter.js';
import type { IssueAdapter } from '../client/adapters/issue.adapter.js';
import type { WorklogAdapter } from '../client/adapters/worklog.adapter.js';
import type { AttachmentAdapter } from '../client/adapters/attachment.adapter.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ToolContext {
  config: OnesConfig;
  logger: Logger;
  tokenStore: TokenStore;
  refreshManager: RefreshManager;
  triggerInteractiveLogin: (timeoutMs?: number, overrideBaseUrl?: string) => Promise<AuthSession>;
  wiki: WikiAdapter;
  project: ProjectAdapter;
  issue: IssueAdapter;
  worklog: WorklogAdapter;
  attachment: AttachmentAdapter;
}

export function toolJson(data: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
  };
}

export function resolveTeamUUID(
  ctx: ToolContext,
  explicitTeam?: string,
  parsedTeam?: string
): string {
  const session = ctx.refreshManager.getCurrentSession();
  const team =
    explicitTeam?.trim() ||
    parsedTeam?.trim() ||
    session?.teamUUID ||
    ctx.config.defaultTeamUUID;
  if (!team) {
    throw new OnesApiError(
      'VALIDATION_ERROR',
      'Missing teamUUID. Pass teamUUID, paste a full ONES URL, or run `ones_login` / set ONES_TEAM_UUID.'
    );
  }
  return team;
}

export async function withToolErrors<T extends CallToolResult = CallToolResult>(
  fn: () => Promise<T>
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return formatMcpError(err);
  }
}
