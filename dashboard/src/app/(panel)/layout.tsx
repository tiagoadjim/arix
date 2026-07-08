import { InboxList } from './inbox-list';

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-screen grid-cols-[360px_1fr] bg-background">
      <InboxList />
      <main className="flex min-h-0 flex-col">{children}</main>
    </div>
  );
}
