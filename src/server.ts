import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig } from './config/env.js';
import { getAuthFilePath, getBrowserProfileDir } from './config/paths.js';
import { createLogger, type LogLevel } from './client/logger.js';
import { TokenStore } from './auth/token-store.js';
import { runInteractiveBrowserLogin, trySilentBrowserRefresh } from './auth/login-flow.js';
import { RefreshManager } from './auth/refresh-manager.js';
import { OnesHttpClient } from './client/http-client.js';
import { OnesApiError } from './client/errors.js';
import { WikiAdapter } from './client/adapters/wiki.adapter.js';
import { ProjectAdapter } from './client/adapters/project.adapter.js';
import { IssueAdapter } from './client/adapters/issue.adapter.js';
import { WorklogAdapter } from './client/adapters/worklog.adapter.js';
import { AttachmentAdapter } from './client/adapters/attachment.adapter.js';
import { registerAllTools } from './tools/register-all.js';
import type { ToolContext } from './tools/helpers.js';

export function createOnesMcpServer(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fetchImpl?: typeof fetch;
}): { server: McpServer; ctx: ToolContext } {
  const homeDir = options?.homeDir ?? os.homedir();
  const config = loadConfig({ env: options?.env, homeDir });
  const envLevel = options?.env?.ONES_LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
  const logger = createLogger(envLevel ? { minLevel: envLevel } : undefined);
  const tokenStore = new TokenStore(getAuthFilePath(homeDir));
  const profileDir = getBrowserProfileDir(homeDir);
  const fetchImpl = options?.fetchImpl ?? fetch;

  const refreshManager = new RefreshManager({
    tokenStore,
    fetchImpl,
    silentBrowserRefresh: () =>
      trySilentBrowserRefresh({
        baseUrl: config.baseUrl,
        profileDir,
        browserPath: config.browserPath,
        logger
      }),
    logger
  });

  const http = new OnesHttpClient({
    baseUrl: config.baseUrl,
    refreshManager,
    fetchImpl,
    logger
  });

  const ctx: ToolContext = {
    config,
    logger,
    tokenStore,
    refreshManager,
    triggerInteractiveLogin: async (timeoutMs, overrideBaseUrl) => {
      const loginBaseUrl = overrideBaseUrl?.trim() || config.baseUrl;
      if (!loginBaseUrl) {
        throw new OnesApiError(
          'VALIDATION_ERROR',
          'Missing ONES base URL. Pass baseUrl to login or configure ONES_BASE_URL.'
        );
      }
      const session = await runInteractiveBrowserLogin({
        baseUrl: loginBaseUrl,
        profileDir,
        browserPath: config.browserPath,
        timeoutMs,
        logger
      });
      tokenStore.write(session);
      return session;
    },
    wiki: new WikiAdapter(http, config.maxReadBytes),
    project: new ProjectAdapter(http),
    issue: new IssueAdapter(http),
    worklog: new WorklogAdapter(http),
    attachment: new AttachmentAdapter(http, config.maxReadBytes)
  };

  const server = new McpServer({
    name: 'ones-mcp-server',
    version: '1.0.0'
  });
  registerAllTools(server, ctx);

  return { server, ctx };
}
