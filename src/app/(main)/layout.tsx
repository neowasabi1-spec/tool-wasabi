import AuthGate from '@/components/AuthGate';
import ConditionalLayout from '@/components/ConditionalLayout';
import { SupabaseProvider } from '@/components/SupabaseProvider';
import FetchAuthBootstrap from '@/components/FetchAuthBootstrap';
import ImpersonationBanner from '@/components/ImpersonationBanner';

export default function MainAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Install the global fetch interceptor BEFORE the AuthGate so any
          early /api/* call made during the auth resolution phase already
          carries the Bearer token. */}
      <FetchAuthBootstrap />
      <ImpersonationBanner />
      <AuthGate>
        <SupabaseProvider>
          <ConditionalLayout>{children}</ConditionalLayout>
        </SupabaseProvider>
      </AuthGate>
    </>
  );
}
