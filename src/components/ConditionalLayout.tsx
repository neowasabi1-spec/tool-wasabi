'use client';

import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';
import OpenClawChat from './OpenClawChat';

export default function ConditionalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isMobileOnlyPage = pathname === '/m';
  const isProjectDetail = /^\/projects\/[^/]+(\/|$)/.test(pathname || '');

  if (isMobileOnlyPage || isProjectDetail) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0 bg-gradient-to-br from-slate-50 via-gray-50 to-slate-100/60">{children}</main>
      <OpenClawChat />
    </div>
  );
}
