import os from 'node:os';
import path from 'node:path';

export function getStateDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.ones-mcp');
}

export function getAuthFilePath(homeDir: string = os.homedir()): string {
  return path.join(getStateDir(homeDir), 'auth.json');
}

export function getConfigFilePath(homeDir: string = os.homedir()): string {
  return path.join(getStateDir(homeDir), 'config.json');
}

export function getBrowserProfileDir(homeDir: string = os.homedir()): string {
  return path.join(getStateDir(homeDir), 'browser-profile');
}
