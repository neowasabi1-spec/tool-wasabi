import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Funnel Swiper Dashboard',
  description: 'Gestione attività di swipe funnel',
};

/**
 * Nessun Supabase/useStore nel root layout: durante `next build` su Netlify
 * alcune pagine pubbliche (/login, /reverse-funnel) venivano prerenderizzate insieme
 * al Provider e caricavano @supabase/supabase-js anche senza env.
 * Dashboard e il resto stanno in `app/(main)/layout.tsx`.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
