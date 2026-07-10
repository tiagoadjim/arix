import { jwtVerify } from 'jose';

export const SESSION_COOKIE = 'arix_session';

export type DashboardRole = 'admin' | 'agent';

export interface DashboardSession {
  id: string;
  role: DashboardRole;
}

/** Verify and decode only the claims needed by the Next.js route shell. */
export async function getValidSession(token: string | undefined): Promise<DashboardSession | null> {
  if (!token) return null;
  const secret = process.env.AUTH_JWT_SECRET;
  // Fail closed on misconfiguration — never verify against an empty key (which
  // would accept attacker-forged empty-key tokens).
  if (!secret || secret.length < 16) {
    console.error('AUTH_JWT_SECRET missing or too short — denying all sessions');
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      issuer: 'arix-server',
      audience: 'arix-dashboard',
    });
    if (!payload.sub || (payload.role !== 'admin' && payload.role !== 'agent')) return null;
    const sessionVersion = Number(payload.sv);
    if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) return null;
    return { id: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}

/** Verify the session cookie (used by middleware to gate routes). */
export async function isValidSession(token: string | undefined): Promise<boolean> {
  return (await getValidSession(token)) !== null;
}
