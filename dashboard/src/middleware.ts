import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, getValidSession } from '@/lib/auth';

interface SetupStatus {
  needsSetup: boolean;
  setupCompleted: boolean;
}

/** Cookie the wizard's "continue later" link sets, so postponing setup is not
 * undone by the auto-launch redirect on the very next navigation. */
const SETUP_SNOOZE_COOKIE = 'arix_setup_snooze';

/**
 * Memo for the *completed* answer only.
 *
 * `setup.completed` is monotonic: once true it never goes back. Caching that
 * one result keeps a per-navigation fetch off the hot path forever after
 * onboarding, while an unfinished install still re-checks every time — so
 * finishing the wizard takes effect on the next navigation, not in a minute.
 */
let setupCompletedMemo = false;

async function isSetupCompleted(): Promise<boolean | null> {
  if (setupCompletedMemo) return true;
  const status = await fetchSetupStatus();
  if (!status) return null;
  if (status.setupCompleted) setupCompletedMemo = true;
  return status.setupCompleted;
}

/** Server-side fetch of the public `GET /api/setup/status` — same target
 * next.config.mjs's dev-time rewrite proxies to (SERVER_API_URL, defaulting
 * to the local server port). Never throws: a network failure or non-2xx
 * response resolves to `null` so callers decide how to fail open/closed
 * instead of the middleware crashing outright. */
async function fetchSetupStatus(): Promise<SetupStatus | null> {
  const base = process.env.SERVER_API_URL || 'http://localhost:3001';
  try {
    const res = await fetch(`${base}/api/setup/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as SetupStatus;
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await getValidSession(token);
  const authed = session !== null;
  const { pathname } = request.nextUrl;
  const isLogin = pathname.startsWith('/login');
  const isSetup = pathname.startsWith('/setup');
  const isExpiredLogin = isLogin && request.nextUrl.searchParams.get('expired') === '1';

  if (authed && session.role !== 'admin' && (isSetup || pathname.startsWith('/config') || pathname.startsWith('/analytics'))) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  if (isSetup) {
    // The wizard needs `needsSetup`/`setupCompleted` regardless of auth state,
    // so this is the one path where a session existing doesn't skip the fetch.
    const status = await fetchSetupStatus();
    if (status) {
      // An authed admin who already finished onboarding has no reason to be
      // in the wizard — send them to the dashboard. Mid-wizard (setup not
      // completed yet) they stay, even though `needsSetup` is already false
      // (their own admin account is what made it false).
      if (authed && !status.needsSetup && status.setupCompleted) {
        return NextResponse.redirect(new URL('/', request.url));
      }
      // No session, and someone else already completed onboarding on this
      // server — this browser should log in, not go through setup again.
      if (!authed && !status.needsSetup) {
        return NextResponse.redirect(new URL('/login', request.url));
      }
    }
    // Allow otherwise: authed + mid-wizard, no session + needsSetup, or the
    // status fetch itself failed (fail OPEN into the wizard, never crash).
    return NextResponse.next();
  }

  if (authed && isLogin && !isExpiredLogin) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  // Auto-launch: opening Arix for the first time lands on the wizard, whether
  // that is a domain or a local install. Scoped to the root path on purpose —
  // "opening the system" is exactly what a visit to `/` means, and an
  // administrator who deliberately navigates to a conversation or to Settings
  // should not be bounced out of it. The panel shows a banner instead.
  if (authed && session.role === 'admin' && pathname === '/' && !request.cookies.has(SETUP_SNOOZE_COOKIE)) {
    // Null (the status fetch failed) falls through: never trap someone in a
    // redirect because the API was briefly unreachable.
    if ((await isSetupCompleted()) === false) {
      return NextResponse.redirect(new URL('/setup', request.url));
    }
  }

  if (!authed && !isLogin) {
    // Route a fresh, unconfigured install to the wizard instead of a login
    // form with no account to sign into yet.
    const status = await fetchSetupStatus();
    return NextResponse.redirect(new URL(status?.needsSetup ? '/setup' : '/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything EXCEPT the proxied API and static assets.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
