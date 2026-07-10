import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config';
import type { StaffRole } from '../types';

const SECRET = new TextEncoder().encode(config.AUTH_JWT_SECRET);

export const SESSION_COOKIE = 'arix_session';

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
  role: StaffRole;
  sessionVersion: number;
}

const ISSUER = 'arix-server';
const AUDIENCE = 'arix-dashboard';

export async function signSession(staff: {
  id: string;
  email: string;
  name: string | null;
  role?: StaffRole;
  session_version?: number;
}): Promise<string> {
  return new SignJWT({
    email: staff.email,
    name: staff.name ?? undefined,
    role: staff.role ?? 'admin',
    sv: staff.session_version ?? 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(staff.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(SECRET);
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (!payload.sub || (payload.role !== 'admin' && payload.role !== 'agent')) return null;
    const sessionVersion = Number(payload.sv);
    if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) return null;
    return {
      id: String(payload.sub),
      email: String(payload.email ?? ''),
      name: typeof payload.name === 'string' ? payload.name : undefined,
      role: payload.role,
      sessionVersion,
    };
  } catch {
    return null;
  }
}
