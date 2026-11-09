import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  installMcpClientConfig,
  resolveClientConfigPath,
  type TargetClient
} from '../src/config/install-config.js';
import { runDoctor } from '../src/cli/doctor.js';
import type { ToolContext } from '../src/tools/helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('resolveClientConfigPath', () => {
  it('resolves correct paths for antigravity, cursor, and claude across platforms', () => {
    const fakeHome = '/fake/home';
    expect(resolveClientConfigPath('antigravity', fakeHome)).toBe(
      path.join(fakeHome, '.gemini', 'config', 'mcp_config.json')
    );
    expect(resolveClientConfigPath('cursor', fakeHome)).toBe(
      path.join(fakeHome, '.cursor', 'mcp.json')
    );
    expect(resolveClientConfigPath('claude', fakeHome, 'darwin')).toBe(
      path.join(fakeHome, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    );
    expect(resolveClientConfigPath('claude', fakeHome, 'win32')).toBe(
      path.join(fakeHome, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
    );
    expect(resolveClientConfigPath('claude', fakeHome, 'linux')).toBe(
      path.join(fakeHome, '.config', 'Claude', 'claude_desktop_config.json')
    );
  });
});

describe('installMcpClientConfig', () => {
  it('merges ones server entry while preserving existing MCP servers and creating .bak backup', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ones-inst-'));
    try {
      const targetDir = path.join(fakeHome, '.gemini', 'config');
      fs.mkdirSync(targetDir, { recursive: true });
      const targetFile = path.join(targetDir, 'mcp_config.json');
      fs.writeFileSync(
        targetFile,
        JSON.stringify({ mcpServers: { existing: { command: 'echo', args: ['hi'] } } }, null, 2)
      );

      const res = installMcpClientConfig({
        client: 'antigravity',
        serverEntryPath: '/opt/ones-mcp-server/dist/index.js',
        baseUrl: 'https://ones.example.com',
        homeDir: fakeHome
      });

      expect(res.configPath).toBe(targetFile);
      expect(res.backupPath).toBeDefined();
      expect(fs.existsSync(res.backupPath!)).toBe(true);

      const updated = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
      expect(updated.mcpServers.existing).toEqual({ command: 'echo', args: ['hi'] });
      expect(updated.mcpServers.ones.command).toBe('node');
      expect(updated.mcpServers.ones.args).toEqual(['/opt/ones-mcp-server/dist/index.js']);
      expect(updated.mcpServers.ones.env.ONES_BASE_URL).toBe('https://ones.example.com');
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('creates fresh config file when none exists (no backup created) and handles cursor client', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ones-cursor-'));
    try {
      const res = installMcpClientConfig({
        client: 'cursor',
        serverEntryPath: '/path/to/entry.js',
        homeDir: fakeHome
      });

      expect(res.configPath).toBe(path.join(fakeHome, '.cursor', 'mcp.json'));
      expect(res.backupPath).toBeUndefined();
      expect(fs.existsSync(res.configPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(res.configPath, 'utf8'));
      expect(content.mcpServers.ones).toEqual({
        command: 'node',
        args: ['/path/to/entry.js']
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('installs claude desktop config preserving existing root fields', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ones-claude-'));
    try {
      const claudeDir = path.join(fakeHome, 'Library', 'Application Support', 'Claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const claudeFile = path.join(claudeDir, 'claude_desktop_config.json');
      fs.writeFileSync(claudeFile, JSON.stringify({ customSetting: true }, null, 2));

      const res = installMcpClientConfig({
        client: 'claude',
        serverEntryPath: '/path/to/claude/entry.js',
        homeDir: fakeHome,
        platform: 'darwin'
      });

      expect(res.configPath).toBe(claudeFile);
      expect(res.backupPath).toBe(`${claudeFile}.bak`);
      expect(fs.existsSync(res.backupPath!)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
      expect(parsed.customSetting).toBe(true);
      expect(parsed.mcpServers.ones.command).toBe('node');
      expect(parsed.mcpServers.ones.args).toEqual(['/path/to/claude/entry.js']);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe('runDoctor', () => {
  it('returns unauthenticated failure check when no session exists', async () => {
    const ctx = {
      config: { baseUrl: 'https://ones.example.com', defaultTeamUUID: 'T1' },
      refreshManager: {
        getCurrentSession: () => null
      }
    } as unknown as ToolContext;

    const checks = await runDoctor(ctx);
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(false);
    expect(checks[0].name).toBe('auth.session');
    expect(checks[0].detail).toContain('Not logged in');
  });

  it('returns failure check when token exists but teamUUID is missing', async () => {
    const ctx = {
      config: { baseUrl: 'https://ones.example.com', defaultTeamUUID: undefined },
      refreshManager: {
        getCurrentSession: () => ({
          baseUrl: 'https://ones.example.com',
          accessToken: 'tok',
          teamUUID: undefined
        })
      }
    } as unknown as ToolContext;

    const checks = await runDoctor(ctx);
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(false);
    expect(checks[0].name).toBe('auth.session');
    expect(checks[0].detail).toContain('teamUUID missing');
  });

  it('verifies auth, wiki read, project read, and issue search safely without writes', async () => {
    const ctx = {
      config: { baseUrl: 'https://ones.example.com', defaultTeamUUID: 'T1', maxReadBytes: 15_000_000 },
      refreshManager: {
        getCurrentSession: () => ({
          baseUrl: 'https://ones.example.com',
          accessToken: 'tok',
          teamUUID: 'T1',
          capturedAt: Date.now()
        })
      },
      wiki: {
        listSpaces: vi.fn(async () => [{ spaceUUID: 'sp1', name: 'Engineering' }]),
        getPageTree: vi.fn(async () => [{ pageUUID: 'pg1', title: 'Home', nodeType: 'online_page', hasChildren: false, children: [] }])
      },
      project: {
        listProjects: vi.fn(async () => [{ projectUUID: 'prj1', name: 'Main' }])
      },
      issue: {
        searchIssues: vi.fn(async () => [{ issueUUID: 'iss1', summary: 'Sample', url: 'https://x' }])
      }
    } as unknown as ToolContext;

    const checks = await runDoctor(ctx);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toEqual([
      'auth.session',
      'wiki.listSpaces',
      'wiki.getPageTree',
      'project.listProjects',
      'issue.searchIssues'
    ]);
  });

  it('handles API errors gracefully and reports failure details', async () => {
    const ctx = {
      config: { baseUrl: 'https://ones.example.com', defaultTeamUUID: 'T1' },
      refreshManager: {
        getCurrentSession: () => ({
          baseUrl: 'https://ones.example.com',
          accessToken: 'tok',
          teamUUID: 'T1'
        })
      },
      wiki: {
        listSpaces: vi.fn(async () => {
          throw new Error('Wiki network 503');
        })
      },
      project: {
        listProjects: vi.fn(async () => {
          throw new Error('Project permission denied');
        })
      },
      issue: {
        searchIssues: vi.fn(async () => {
          throw new Error('Issue query timeout');
        })
      }
    } as unknown as ToolContext;

    const checks = await runDoctor(ctx);
    expect(checks[0].ok).toBe(true); // auth.session ok
    expect(checks[1]).toEqual({
      name: 'wiki.listSpaces',
      ok: false,
      detail: 'Wiki network 503'
    });
    // Since listSpaces failed, firstSpaceUUID was undefined so getPageTree is skipped
    expect(checks[2]).toEqual({
      name: 'project.listProjects',
      ok: false,
      detail: 'Project permission denied'
    });
    expect(checks[3]).toEqual({
      name: 'issue.searchIssues',
      ok: false,
      detail: 'Issue query timeout'
    });
  });

  it('redacts secrets like Bearer tokens in doctor error details across all checks', async () => {
    const ctx = {
      config: { baseUrl: 'https://ones.example.com', defaultTeamUUID: 'T1' },
      refreshManager: {
        getCurrentSession: () => ({
          baseUrl: 'https://ones.example.com',
          accessToken: 'tok',
          teamUUID: 'T1'
        })
      },
      wiki: {
        listSpaces: vi.fn(async () => [{ spaceUUID: 'sp1', name: 'Eng' }]),
        getPageTree: vi.fn(async () => {
          throw new Error('Wiki tree failed with Bearer secret-token-123');
        })
      },
      project: {
        listProjects: vi.fn(async () => {
          throw new Error('Project failed with Bearer secret-token-123');
        })
      },
      issue: {
        searchIssues: vi.fn(async () => {
          throw new Error('Issue failed with Bearer secret-token-123');
        })
      }
    } as unknown as ToolContext;

    const checks = await runDoctor(ctx);
    const failedChecks = checks.filter((c) => !c.ok);
    expect(failedChecks).toHaveLength(3);
    for (const check of failedChecks) {
      expect(check.detail).not.toContain('secret-token-123');
      expect(check.detail).toContain('Bearer [REDACTED]');
    }

    // Also test wiki.listSpaces error redaction directly
    const ctxSpacesFail = {
      ...ctx,
      wiki: {
        listSpaces: vi.fn(async () => {
          throw new Error('Spaces error with Bearer secret-token-123');
        })
      }
    } as unknown as ToolContext;
    const checksSpaces = await runDoctor(ctxSpacesFail);
    const spaceCheck = checksSpaces.find((c) => c.name === 'wiki.listSpaces');
    expect(spaceCheck?.ok).toBe(false);
    expect(spaceCheck?.detail).not.toContain('secret-token-123');
    expect(spaceCheck?.detail).toContain('Bearer [REDACTED]');
  });
});

describe('CLI compiled smoke test', () => {
  it('displays help when invoked with --help on built dist/cli.js', () => {
    const cliPath = path.resolve(__dirname, '../dist/cli.js');
    if (!fs.existsSync(cliPath)) {
      // Build first if dist/cli.js does not exist
      execFileSync('npm', ['run', 'build'], {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'pipe'
      });
    }
    const output = execFileSync(process.execPath, [cliPath, '--help'], {
      encoding: 'utf8'
    });
    expect(output).toContain('ones-mcp CLI');
    expect(output).toContain('Usage:');
    expect(output).toContain('ones-mcp login');
    expect(output).toContain('ones-mcp status');
    expect(output).toContain('ones-mcp logout');
    expect(output).toContain('ones-mcp doctor');
    expect(output).toContain('ones-mcp install-config [client]');
    expect(output).toContain('ones-mcp serve');
  });

  it('exits with code 1 and error message when install-config --client is missing a value', () => {
    const cliPath = path.resolve(__dirname, '../dist/cli.js');
    execFileSync('npm', ['run', 'build'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe'
    });
    try {
      execFileSync(process.execPath, [cliPath, 'install-config', '--client'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      expect.fail('Should have exited with non-zero exit code');
    } catch (err: any) {
      expect(err.status).toBe(1);
      expect(err.stderr).toContain('Missing client argument for --client');
    }
  });
});
