import AuthGate from '@/components/AuthGate';
import ConditionalLayout from '@/components/ConditionalLayout';
import { SupabaseProvider } from '@/components/SupabaseProvider';

export default function MainAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <SupabaseProvider>
        <ConditionalLayout>{children}</ConditionalLayout>
      </SupabaseProvider>
    </AuthGate>
  );
}
