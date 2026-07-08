import { jwtVerify } from 'jose';

export const SESSION_COOKIE = 'arix_session';

/** Verify the session cookie (used by middleware to gate routes). */
export async function isValidSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const secret = process.env.AUTH_JWT_SECRET;
  // Fail closed on misconfiguration — never verify against an empty key (which
  // would accept attacker-forged empty-key tokens).
  if (!secret || secret.length < 16) {
    console.error('AUTH_JWT_SECRET missing or too short — denying all sessions');
    return false;
  }
  try {
    await jwtVerify(token, new TextEncoder().encode(secret));
    return true;
  } catch {
    return false;
  }
}
