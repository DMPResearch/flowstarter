'use client';

import '@flowstarter/flow-design-system/styles/landing.css';
import './admin-login-contrast.css';

import AuthLayout from '@/components/auth/AuthLayout';
import { AuthFormCard } from '@/components/auth/AuthFormCard';
import { LoginForm } from '@/components/auth/LoginForm';
import { AuthRedirectWrapper } from '@/components/AuthRedirectWrapper';
import { useTranslations } from '@/lib/i18n';
import { useClerk, useUser } from '@clerk/nextjs';
import { useSignIn } from '@clerk/nextjs/legacy';
import { useSearchParams, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@flowstarter/flow-design-system';

export default function TeamLoginPage() {
  const { isLoaded } = useSignIn();
  const { t } = useTranslations();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { signOut } = useClerk();
  const { user } = useUser();
  const [mounted, setMounted] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || !isLoaded) {
    return (
      <div
        className="admin-team-login-scope ls-scope min-h-screen flex items-center justify-center relative"
        suppressHydrationWarning
      >
        <Loader2 className="w-8 h-8 animate-spin text-[var(--ls-accent)]" />
      </div>
    );
  }

  const rejected = searchParams.get('reason') === 'not_admin' && !!user;

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut();
      const qs = new URLSearchParams();
      const r = searchParams.get('redirect_url');
      const n = searchParams.get('next');
      if (r) qs.set('redirect_url', r);
      if (n) qs.set('next', n);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      router.replace(`/admin/login${suffix}`);
    } finally {
      setSigningOut(false);
    }
  };

  // Wrap in AuthRedirectWrapper so already-signed-in admins (e.g. coming back
  // from the editor with a stale tab/session) get auto-redirected to the
  // editor's `?redirect_url=` instead of stalling on the login form. The
  // wrapper itself bails out when `reason=not_admin` is present so the
  // rejection UI below still gets a chance to render and offer sign-out.
  return (
    <div className="admin-team-login-scope ls-scope min-h-screen flex flex-col relative">
      <AuthRedirectWrapper>
        <AuthLayout
          title={t('team.login.title')}
          subtitle={t('team.login.subtitle')}
          showStats={false}
          teamLandingVisual
        >
          <AuthFormCard landingSurface>
            {rejected ? (
              <div className="space-y-4">
                <div className="flex items-start gap-3 rounded-xl border border-amber-300/50 bg-amber-50 p-4 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div>
                    <p className="font-medium text-amber-900 dark:text-amber-200">
                      This account isn&apos;t an admin
                    </p>
                    <p className="mt-1 text-xs text-amber-800 dark:text-amber-300/80">
                      {user.primaryEmailAddress?.emailAddress ?? 'You'}{' '}
                      doesn&apos;t have team access. Sign out and try a
                      different account.
                    </p>
                  </div>
                </div>
                <Button
                  variant="default"
                  size="md"
                  onClick={handleSignOut}
                  disabled={signingOut}
                  className="w-full"
                >
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </Button>
              </div>
            ) : (
              <LoginForm variant="team" />
            )}
          </AuthFormCard>
        </AuthLayout>
      </AuthRedirectWrapper>
    </div>
  );
}
