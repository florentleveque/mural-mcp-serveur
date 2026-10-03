/**
 * Decode the payload of a JWT without verifying its signature. Only meant to
 * read informational claims (`exp`, `scopes`) from our own access token.
 * Returns null for anything that is not a JWT with a JSON object payload.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payloadPart = token.split('.')[1];
  if (!payloadPart) {
    return null;
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf-8'));
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
