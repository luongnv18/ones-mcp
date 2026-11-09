import fs from 'node:fs';
import path from 'node:path';
import { getAuthFilePath } from '../config/paths.js';

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export interface AuthSession {
  baseUrl: string;
  accessToken: string;
  refreshToken?: string;
  refreshEndpoint?: string;
  expiresAt?: number;
  teamUUID?: string;
  userUUID?: string;
  userEmail?: string;
  cookies?: StoredCookie[];
  capturedAt: number;
}

export class TokenStore {
  private readonly filePath: string;

  constructor(filePath: string = getAuthFilePath()) {
    this.filePath = filePath;
  }

  getPath(): string {
    return this.filePath;
  }

  read(): AuthSession | null {
    if (!fs.existsSync(this.filePath)) return null;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as AuthSession;
      if (
        !parsed ||
        typeof parsed.accessToken !== 'string' ||
        !parsed.accessToken ||
        typeof parsed.baseUrl !== 'string' ||
        !parsed.baseUrl
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  write(session: AuthSession): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
    if (process.platform !== 'win32') {
      fs.chmodSync(this.filePath, 0o600);
    }
  }

  clear(): void {
    fs.rmSync(this.filePath, { force: true });
  }
}
