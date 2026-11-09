#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOnesMcpServer } from './server.js';
import { installMcpClientConfig, type TargetClient } from './config/install-config.js';
import { runDoctor } from './cli/doctor.js';

function printHelp(): void {
  process.stdout.write(`ones-mcp CLI

Usage:
  ones-mcp login [baseUrl]            Open Chrome/Edge to log into ONES (+ 2FA OTP) and save token
  ones-mcp status                     Show saved session details and token expiry
  ones-mcp logout                     Remove saved local token
  ones-mcp doctor                     Run read-only API diagnostics against ONES
  ones-mcp install-config [client]    Configure Antigravity, Cursor, or Claude Desktop (default: antigravity)
  ones-mcp serve                      Run MCP server over stdio
`);
}

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp();
    return;
  }

  const { server, ctx } = createOnesMcpServer();

  if (cmd === 'serve') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  if (cmd === 'login') {
    const urlArg = rest.find((a) => a.startsWith('http://') || a.startsWith('https://'));
    const targetBaseUrl = urlArg ?? ctx.config.baseUrl;
    if (!targetBaseUrl) {
      process.stderr.write(
        'Error: No ONES base URL configured. Provide it as an argument or set ONES_BASE_URL:\n' +
        '  ones-mcp login https://ones.yourcompany.com\n'
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Opening browser for ${targetBaseUrl} — complete login & 2FA OTP...\n`);
    const session = await ctx.triggerInteractiveLogin(undefined, targetBaseUrl);
    process.stdout.write(
      `Login captured! baseUrl=${session.baseUrl}, teamUUID=${session.teamUUID ?? 'not-detected'}, tokenFile=${ctx.tokenStore.getPath()}\n`
    );
    return;
  }

  if (cmd === 'logout') {
    ctx.tokenStore.clear();
    process.stdout.write(`Cleared saved session at ${ctx.tokenStore.getPath()}\n`);
    return;
  }

  if (cmd === 'status') {
    const session = ctx.refreshManager.getCurrentSession();
    if (!session) {
      process.stdout.write('Not logged in. Run `ones-mcp login`.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      JSON.stringify(
        {
          baseUrl: session.baseUrl,
          teamUUID: session.teamUUID ?? null,
          userEmail: session.userEmail ?? null,
          hasRefreshToken: Boolean(session.refreshToken),
          expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  if (cmd === 'doctor') {
    const checks = await runDoctor(ctx);
    let allOk = true;
    for (const c of checks) {
      if (!c.ok) allOk = false;
      process.stdout.write(`${c.ok ? '[OK]' : '[FAIL]'} ${c.name}: ${c.detail}\n`);
    }
    if (!allOk) process.exitCode = 1;
    return;
  }

  if (cmd === 'install-config') {
    if (rest[0] === '--client' && !rest[1]) {
      process.stderr.write('Missing client argument for --client. Use: antigravity | cursor | claude | all\n');
      process.exitCode = 1;
      return;
    }
    const clientArg = (rest[0] === '--client' ? rest[1] : rest[0]) ?? 'antigravity';
    const valid: TargetClient[] = ['antigravity', 'cursor', 'claude'];
    const targets: TargetClient[] =
      clientArg === 'all' ? valid : valid.includes(clientArg as TargetClient) ? [clientArg as TargetClient] : [];

    if (targets.length === 0) {
      process.stderr.write(`Unknown client "${clientArg}". Use: antigravity | cursor | claude | all\n`);
      process.exitCode = 1;
      return;
    }

    const distDir = path.dirname(fileURLToPath(import.meta.url));
    const entryPath = path.join(distDir, 'index.js');
    for (const client of targets) {
      const res = installMcpClientConfig({
        client,
        serverEntryPath: entryPath,
        baseUrl: ctx.config.baseUrl || undefined
      });
      process.stdout.write(
        `Updated ${client}: ${res.configPath}${res.backupPath ? ` (backup: ${res.backupPath})` : ''}\n`
      );
    }
    return;
  }

  process.stderr.write(`Unknown command: ${cmd}\n`);
  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
