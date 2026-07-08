import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Arix',
  description: 'Panel de atención humana para Arix',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
