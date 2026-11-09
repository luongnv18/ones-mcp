export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function getTokenExpiresAt(token: string): number | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  const exp = payload.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
}

export function isTokenExpiringSoon(
  expiresAt?: number,
  bufferSeconds = 300,
  nowMs: number = Date.now()
): boolean {
  if (expiresAt === undefined) return false;
  return nowMs + bufferSeconds * 1000 >= expiresAt;
}
