export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export function redactSecrets(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(
      /("(?:access_?token|refresh_?token|ones-auth-token|authorization|password|cookie)"\s*:\s*)"([^"]+)"/gi,
      '$1"[REDACTED]"'
    )
    .replace(/(set-cookie\s*[:=]\s*)([^\r\n]+)/gi, '$1[REDACTED]')
    .replace(/(cookie\s*[:=]\s*)([^\r\n]+)/gi, '$1[REDACTED]');
}

export function createLogger(options?: {
  write?: (line: string) => void;
  minLevel?: LogLevel;
}): Logger {
  const envLevel = process.env.ONES_LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
  const minLevel = options?.minLevel ?? envLevel ?? 'info';
  const minRank = LEVEL_RANK[minLevel] ?? LEVEL_RANK.info;
  const write = options?.write ?? ((line: string) => process.stderr.write(`${line}\n`));

  const emit = (level: LogLevel, msg: string, meta?: unknown) => {
    if (LEVEL_RANK[level] < minRank) return;
    let metaText = '';
    if (meta !== undefined) {
      if (meta instanceof Error) {
        metaText = ` ${meta.stack ?? meta.message}`;
      } else if (typeof meta === 'string') {
        metaText = ` ${meta}`;
      } else {
        try {
          metaText = ` ${JSON.stringify(meta)}`;
        } catch {
          metaText = ` ${String(meta)}`;
        }
      }
    }
    const safeLine = redactSecrets(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}${metaText}`);
    write(safeLine);
  };

  return {
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta)
  };
}
