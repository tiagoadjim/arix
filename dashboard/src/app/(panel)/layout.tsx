import { cookies } from 'next/headers';
import { getValidSession, SESSION_COOKIE } from '@/lib/auth';
import { PanelShell } from './panel-shell';

/** Same public endpoint middleware.ts reads, resolved to `false` on any
 * failure so a brief API hiccup never renders a misleading "unfinished setup"
 * banner over a perfectly configured install. */
async function setupIsUnfinished(): Promise<boolean> {
  const base = process.env.SERVER_API_URL || 'http://localhost:3001';
  try {
    const res = await fetch(`${base}/api/setup/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return false;
    const status = (await res.json()) as { setupCompleted?: boolean };
    return status.setupCompleted === false;
  } catch {
    return false;
  }
}

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const session = await getValidSession(cookieStore.get(SESSION_COOKIE)?.value);
  const isAdmin = session?.role === 'admin';
  return (
    <PanelShell canManageSettings={isAdmin} setupUnfinished={isAdmin && (await setupIsUnfinished())}>
      {children}
    </PanelShell>
  );
}
