import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, isValidSession } from '@/lib/auth';

export async function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const authed = await isValidSession(token);
  const isLogin = request.nextUrl.pathname.startsWith('/login');

  if (!authed && !isLogin) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  if (authed && isLogin) {
    return NextResponse.redirect(new URL('/', request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Run on everything EXCEPT the proxied API and static assets.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
