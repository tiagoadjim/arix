import { cookies } from 'next/headers';
import { getValidSession, SESSION_COOKIE } from '@/lib/auth';
import { PanelShell } from './panel-shell';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const session = await getValidSession(cookieStore.get(SESSION_COOKIE)?.value);
  return <PanelShell canManageSettings={session?.role === 'admin'}>{children}</PanelShell>;
}
