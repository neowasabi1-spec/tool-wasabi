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

  if (isMobileOnlyPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 bg-gray-50">{children}</main>
      <OpenClawChat />
    </div>
  );
}
