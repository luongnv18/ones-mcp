import { redactSecrets } from './logger.js';

export type OnesErrorCode =
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'PAGE_LOCKED'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED_FILE'
  | 'NETWORK_ERROR'
  | 'API_ERROR';

export class OnesApiError extends Error {
  readonly code: OnesErrorCode;
  readonly status?: number;
  readonly details?: unknown;

  constructor(
    code: OnesErrorCode,
    message: string,
    options?: { status?: number; details?: unknown }
  ) {
    super(message);
    this.name = 'OnesApiError';
    this.code = code;
    this.status = options?.status;
    this.details = options?.details;
  }
}

export function formatMcpError(err: unknown): {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
} {
  if (err instanceof OnesApiError) {
    const lines = [`[${err.code}] ${redactSecrets(err.message)}`];
    if (err.status) lines.push(`HTTP Status: ${err.status}`);
    if (err.code === 'AUTH_REQUIRED') {
      lines.push(
        'Action required: Call tool `ones_login` (or run `ones-mcp login` in your terminal) to authenticate via browser with your 2FA OTP.'
      );
    }
    if (err.details !== undefined) {
      let detailText: string;
      if (typeof err.details === 'string') {
        detailText = err.details;
      } else {
        try {
          detailText = JSON.stringify(err.details);
        } catch {
          detailText = String(err.details);
        }
      }
      lines.push(`Details: ${redactSecrets(detailText)}`);
    }
    return {
      isError: true,
      content: [{ type: 'text', text: lines.join('\n') }]
    };
  }

  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: `[API_ERROR] ${redactSecrets(msg)}` }]
  };
}
