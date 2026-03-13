import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import ConditionalLayout from '@/components/ConditionalLayout';
import { SupabaseProvider } from '@/components/SupabaseProvider';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Funnel Swiper Dashboard',
  description: 'Gestione attività di swipe funnel',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="it">
      <body className={inter.className}>
        <SupabaseProvider>
          <ConditionalLayout>{children}</ConditionalLayout>
        </SupabaseProvider>
      </body>
    </html>
  );
}
