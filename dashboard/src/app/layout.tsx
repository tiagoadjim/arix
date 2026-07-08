import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Nico — Vapenic',
  description: 'Panel de atención humana para Nico (Vapenic)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
