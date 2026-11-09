import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type TargetClient = 'antigravity' | 'cursor' | 'claude';

export function resolveClientConfigPath(
  client: TargetClient,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  if (client === 'antigravity') {
    return path.join(homeDir, '.gemini', 'config', 'mcp_config.json');
  }
  if (client === 'cursor') {
    return path.join(homeDir, '.cursor', 'mcp.json');
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (platform === 'win32') {
    return path.join(homeDir, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(homeDir, '.config', 'Claude', 'claude_desktop_config.json');
}

export function installMcpClientConfig(options: {
  client: TargetClient;
  serverEntryPath: string;
  baseUrl?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
}): { configPath: string; backupPath?: string } {
  const homeDir = options.homeDir ?? os.homedir();
  const configPath = resolveClientConfigPath(options.client, homeDir, options.platform);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  let existing: Record<string, unknown> = {};
  let backupPath: string | undefined;

  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    backupPath = `${configPath}.bak`;
    fs.writeFileSync(backupPath, raw);
    if (raw.trim()) {
      try {
        existing = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }
  }

  const prevServers =
    existing.mcpServers && typeof existing.mcpServers === 'object'
      ? (existing.mcpServers as Record<string, unknown>)
      : {};

  const onesServerEntry: Record<string, unknown> = {
    command: 'node',
    args: [options.serverEntryPath]
  };
  if (options.baseUrl?.trim()) {
    onesServerEntry.env = {
      ONES_BASE_URL: options.baseUrl.trim()
    };
  }

  const updated = {
    ...existing,
    mcpServers: {
      ...prevServers,
      ones: onesServerEntry
    }
  };

  const tmpPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + '\n');
  fs.renameSync(tmpPath, configPath);

  return { configPath, backupPath };
}
