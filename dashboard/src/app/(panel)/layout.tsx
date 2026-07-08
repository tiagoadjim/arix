import { InboxList } from './inbox-list';

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <InboxList />
      <main className="main">{children}</main>
    </div>
  );
}
