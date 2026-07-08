import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config';

const SECRET = new TextEncoder().encode(config.AUTH_JWT_SECRET);

export const SESSION_COOKIE = 'nico_session';

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

export async function signSession(staff: { id: string; email: string; name: string | null }): Promise<string> {
  return new SignJWT({ email: staff.email, name: staff.name ?? undefined })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(staff.id)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(SECRET);
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (!payload.sub) return null;
    return {
      id: String(payload.sub),
      email: String(payload.email ?? ''),
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  } catch {
    return null;
  }
}
