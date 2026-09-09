/**
 * Shared LoginForm — the canonical Flowstarter sign-in surface.
 *
 * Ported verbatim (markup + flow) from the marketing app's
 * `components/auth/LoginForm.tsx` so the editor and flowstarter-main
 * render the exact same component. All app-specific concerns are
 * dependency-injected via props so this file imports neither a Clerk
 * SDK nor an i18n system:
 *
 *   - `signIn` + `setActive`  → each app passes its own Clerk
 *     `useSignIn()` result (`@clerk/nextjs/legacy` in main,
 *     `@clerk/clerk-react` in the editor — the resource API is
 *     identical, typed structurally below).
 *   - `t`                     → translator (main: useTranslations;
 *     editor: a static English map).
 *   - `getSearchParam`        → router-agnostic query reader.
 *   - `onTransferToken`       → optional cross-domain session hand-off
 *     (main wires /api/auth/transfer-token; editor omits it).
 *
 * `isTeamEmail` comes straight from `@flowstarter/platform-config`
 * (already a design-system dep). Every redirect target is resolved by
 * `../../utils/safe-redirect`, the single gate between a query string
 * and `window.location`.
 *
 * Field chrome uses the brand tokens (--purple / --fs-* / --surface-2)
 * defined in brand.css, so it's pixel-identical across both apps.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { isTeamEmail } from '@flowstarter/platform-config';
import {
  CLIENT_REDIRECT_PATH,
  TEAM_REDIRECT_PATH,
  currentOrigin,
  toSameOriginPath,
  toTrustedHandoffUrl,
} from '../../utils/safe-redirect';

/* ── Structural Clerk types ───────────────────────────────────────────
   Only the surface we touch. Keeps this package SDK-free. */
export interface SharedSignInFactor {
  readonly strategy: string;
  readonly emailAddressId?: string;
  readonly phoneNumberId?: string;
}
export interface SharedSignInResource {
  /**
   * Client Trust (Clerk's device-verification attack protection) is a
   * first-factor step-up: a password sign-in from a client Clerk has not
   * seen before returns `needs_client_trust`, with `email_code` and/or
   * `phone_code` offered here, not in `supportedSecondFactors`.
   */
  readonly supportedFirstFactors?: ReadonlyArray<SharedSignInFactor> | null;
  readonly supportedSecondFactors?: ReadonlyArray<SharedSignInFactor> | null;
  create(params: Record<string, unknown>): Promise<SharedSignInResult>;
  prepareFirstFactor(
    params: Record<string, unknown>,
  ): Promise<SharedSignInResult>;
  attemptFirstFactor(
    params: Record<string, unknown>,
  ): Promise<SharedSignInResult>;
  attemptSecondFactor(
    params: Record<string, unknown>,
  ): Promise<SharedSignInResult>;
}
export interface SharedSignInResult {
  readonly status: string | null;
  readonly createdSessionId: string | null;
}
export type SharedSetActive = (params: {
  session: string | null;
}) => Promise<void>;

export type SharedTranslate = (key: string) => string;

export interface LoginFormProps {
  /** `team` routes to /admin/dashboard, `client` to /dashboard. */
  readonly variant: 'client' | 'team';
  readonly signIn: SharedSignInResource | undefined;
  readonly setActive: SharedSetActive | undefined;
  readonly t: SharedTranslate;
  /** Router-agnostic query reader (URLSearchParams.get shape). */
  readonly getSearchParam: (key: string) => string | null;
  /**
   * Optional cross-domain hand-off. Given a trusted redirect URL,
   * returns a token-bearing URL to navigate to, or null to fall back
   * to a plain redirect. The editor omits this (no such endpoint).
   */
  readonly onTransferToken?: (redirectUrl: string) => Promise<string | null>;
}

/* ── Inlined icons (no lucide dep in this package) ────────────────── */
const IconArrowLeft = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);
const IconEye = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const IconEyeOff = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
    <line x1="2" x2="22" y1="2" y2="22" />
  </svg>
);

/* ── Inlined form primitives (exact platform classes) ─────────────── */
export function isValidEmail(value: string): boolean {
  const v = value.trim();
  if (v.length < 3 || v.length > 254) return false;
  const at = v.indexOf('@');
  if (at <= 0 || at !== v.lastIndexOf('@')) return false;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (!local || !domain || local.includes(' ') || domain.includes(' '))
    return false;
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

function Label({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="flex items-center gap-2 text-sm leading-none font-medium select-none text-muted-foreground"
    >
      {children}
    </label>
  );
}

function FieldInput(
  props: React.InputHTMLAttributes<HTMLInputElement> & { className?: string },
) {
  const { className = '', ...rest } = props;
  return (
    <input
      data-slot="input"
      className={`flex h-12 w-full min-w-0 rounded-lg border px-4 py-2 text-sm shadow-sm transition-[color,box-shadow,border-color,background-color] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...rest}
    />
  );
}

/* ── Error handler (pure; was useClerkErrorHandler) ───────────────── */
interface ClerkErrorLike {
  status?: number;
  code?: number | string;
  message?: string;
  errors?: Array<{
    code?: string;
    message?: string;
    meta?: { param_name?: string };
  }>;
}
type ErrCtx = 'signIn' | 'signUp' | 'reset';

function resolveClerkError(
  err: unknown,
  context: ErrCtx,
  t: SharedTranslate,
): string {
  let message = t('auth.errors.somethingWentWrong');
  if (typeof err === 'string') {
    return context === 'signIn' ? t('auth.errors.signInInvalid') : err;
  }
  if (!err || typeof err !== 'object') return message;
  const e = err as ClerkErrorLike;

  if (
    e.code === 'session_exists' ||
    e.message === 'Session already exists' ||
    (Array.isArray(e.errors) &&
      e.errors.some((x) => x?.code === 'session_exists'))
  ) {
    return '__SESSION_EXISTS__';
  }

  if (e.status === 422 || e.code === 422) {
    if (Array.isArray(e.errors) && e.errors.length > 0) {
      const first = e.errors[0];
      if (first?.code) {
        message = errorForCode(first.code, context, first.message, t);
      } else if (context === 'signIn') {
        message = t('auth.errors.signInInvalid');
      } else {
        message = first?.message || t('auth.errors.somethingWentWrong');
      }
    } else {
      message =
        context === 'signIn'
          ? t('auth.errors.signInInvalid')
          : t('auth.errors.somethingWentWrong');
    }
  } else if (Array.isArray(e.errors)) {
    message =
      context === 'signIn'
        ? t('auth.errors.signInInvalid')
        : t('auth.errors.somethingWentWrong');
  } else if (e.message) {
    message =
      context === 'signIn'
        ? t('auth.errors.signInInvalid')
        : t('auth.errors.somethingWentWrong');
  }
  return message;
}

function errorForCode(
  code: string,
  context: ErrCtx,
  fallback: string | undefined,
  t: SharedTranslate,
): string {
  if (context === 'signIn') {
    if (
      code === 'form_identifier_not_found' ||
      code === 'form_password_incorrect'
    ) {
      return t('auth.errors.signInInvalid');
    }
  }
  if (context === 'signIn') return t('auth.errors.signInInvalid');
  return fallback || t('auth.errors.somethingWentWrong');
}

function clerkErrorMessage(_error: unknown, fallback: string): string {
  // Never surface raw Clerk/provider messages into the DOM (CodeQL js/xss).
  return fallback;
}

function useEdgeBrowserDetection(): boolean {
  const [isEdge, setIsEdge] = useState(false);
  useEffect(() => {
    const ua = navigator.userAgent;
    setIsEdge(ua.includes('Edg/') || ua.includes('Edge/'));
  }, []);
  return isEdge;
}

const FIELD_CLS = [
  'h-12 rounded-lg bg-white/80 border border-white/40 text-foreground backdrop-blur-sm',
  'placeholder:text-muted-foreground/50',
  'dark:border-white/10 dark:bg-[var(--surface-2)]/80 dark:text-white',
  'focus:ring-2 focus:ring-[var(--purple)]/30 focus:border-[var(--purple)]/50 transition-all',
].join(' ');

function SubmitButton({
  children,
  disabled,
  type = 'submit',
  onClick,
  className = '',
}: {
  children: ReactNode;
  disabled?: boolean;
  type?: 'submit' | 'button';
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`w-full rounded-lg font-semibold inline-flex items-center justify-center h-12 px-5 text-sm transition-all duration-200 disabled:opacity-60 disabled:pointer-events-none bg-[var(--purple)] text-white shadow-sm hover:brightness-110 active:brightness-95 ${className}`}
    >
      {children}
    </button>
  );
}

type FlowStep =
  | 'credentials'
  | 'forgot'
  | 'forgot-code'
  | 'mfa'
  | 'client-trust';
type MfaReturnStep = 'credentials' | 'forgot-code';
type ClientTrustStrategy = 'email_code' | 'phone_code';

function supportedMfaStrategies(
  factors: ReadonlyArray<{ strategy: string }> | null | undefined,
): { totp: boolean; backup: boolean } {
  const list = factors ?? [];
  return {
    totp: list.some((f) => f.strategy === 'totp'),
    backup: list.some((f) => f.strategy === 'backup_code'),
  };
}

/**
 * Client Trust offers `email_code` and/or `phone_code` on
 * `supportedFirstFactors`, never both unavailable at once for an account
 * that got this far (Client Trust requires password sign-in to be enabled,
 * and Clerk always leaves at least one contactable identifier verified).
 */
function supportedClientTrustStrategies(
  factors: ReadonlyArray<SharedSignInFactor> | null | undefined,
): { email: boolean; phone: boolean } {
  const list = factors ?? [];
  return {
    email: list.some((f) => f.strategy === 'email_code'),
    phone: list.some((f) => f.strategy === 'phone_code'),
  };
}

function findClientTrustFactor(
  factors: ReadonlyArray<SharedSignInFactor> | null | undefined,
  strategy: ClientTrustStrategy,
): SharedSignInFactor | undefined {
  return (factors ?? []).find((f) => f.strategy === strategy);
}

export function LoginForm({
  variant,
  signIn,
  setActive,
  t,
  getSearchParam,
  onTransferToken,
}: LoginFormProps) {
  const isEdgeBrowser = useEdgeBrowserDetection();
  const isTeam = variant === 'team';

  /**
   * Where sign-in sends the visitor.
   *
   * `path` is always a same-origin path and is the only value that reaches
   * `window.location`. `handoff` is an absolute URL on another platform
   * origin, kept apart because it is only ever handed to the transfer-token
   * endpoint; the browser follows the URL that endpoint mints.
   */
  const getRedirectTarget = (
    userEmail?: string,
  ): { path: string; handoff: string | null } => {
    const origin = currentOrigin();
    const fallback =
      isTeam || (userEmail !== undefined && isTeamEmail(userEmail))
        ? TEAM_REDIRECT_PATH
        : CLIENT_REDIRECT_PATH;

    const redirectUrl = getSearchParam('redirect_url');
    const requested = toSameOriginPath(redirectUrl, origin);
    const next = isTeam
      ? toSameOriginPath(getSearchParam('next'), origin)
      : null;

    return {
      path: requested ?? next ?? fallback,
      handoff: toTrustedHandoffUrl(redirectUrl, origin),
    };
  };

  const navigate = async (sessionId: string | null, userEmail?: string) => {
    if (!setActive) return;
    const target = getRedirectTarget(userEmail);
    await setActive({ session: sessionId });

    if (target.handoff && onTransferToken) {
      try {
        const url = await onTransferToken(target.handoff);
        if (url) {
          window.location.href = url;
          return;
        }
      } catch {
        /* fall through to the same-origin default */
      }
    }

    // No token means the other origin cannot adopt the session, so following
    // the cross-domain URL would only bounce the visitor back to a login page.
    // Land on this origin instead.
    window.location.href = target.path;
  };

  const [step, setStep] = useState<FlowStep>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const [resetEmail, setResetEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isResetLoading, setIsResetLoading] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [mfaReturnStep, setMfaReturnStep] =
    useState<MfaReturnStep>('credentials');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaStrategy, setMfaStrategy] = useState<'totp' | 'backup_code'>(
    'totp',
  );
  const [mfaChoices, setMfaChoices] = useState({ totp: false, backup: false });
  const [isMfaLoading, setIsMfaLoading] = useState(false);

  // Client Trust: a device Clerk has not seen before, on a password sign-in.
  // Same shape as MFA's code entry, but a first factor, not a second one,
  // and offered over email or SMS rather than an authenticator app.
  const [clientTrustCode, setClientTrustCode] = useState('');
  const [clientTrustStrategy, setClientTrustStrategy] =
    useState<ClientTrustStrategy>('email_code');
  const [clientTrustChoices, setClientTrustChoices] = useState({
    email: false,
    phone: false,
  });
  const [isClientTrustLoading, setIsClientTrustLoading] = useState(false);

  const goBackFromMfa = () => {
    setError('');
    setMfaCode('');
    setStep(mfaReturnStep);
  };
  const enterMfaStep = (returnStep: MfaReturnStep) => {
    if (!signIn) return;
    const { totp, backup } = supportedMfaStrategies(
      signIn.supportedSecondFactors,
    );
    if (!totp && !backup) {
      setError(t('auth.mfa.unsupportedFactor'));
      return;
    }
    setError('');
    setMfaChoices({ totp, backup });
    setMfaStrategy(totp ? 'totp' : 'backup_code');
    setMfaCode('');
    setMfaReturnStep(returnStep);
    setStep('mfa');
  };

  /** Sends (or resends) the Client Trust code for the chosen strategy. */
  const sendClientTrustCode = async (strategy: ClientTrustStrategy) => {
    if (!signIn) return;
    const factor = findClientTrustFactor(
      signIn.supportedFirstFactors,
      strategy,
    );
    if (!factor) {
      setError(t('auth.clientTrust.unsupportedFactor'));
      return;
    }
    try {
      await signIn.prepareFirstFactor(
        strategy === 'email_code'
          ? { strategy: 'email_code', emailAddressId: factor.emailAddressId }
          : { strategy: 'phone_code', phoneNumberId: factor.phoneNumberId },
      );
    } catch (err: unknown) {
      setError(clerkErrorMessage(err, t('auth.clientTrust.sendFailed')));
    }
  };
  const goBackFromClientTrust = () => {
    setError('');
    setClientTrustCode('');
    setStep('credentials');
  };
  const enterClientTrustStep = async () => {
    if (!signIn) return;
    const { email, phone } = supportedClientTrustStrategies(
      signIn.supportedFirstFactors,
    );
    if (!email && !phone) {
      setError(t('auth.clientTrust.unsupportedFactor'));
      return;
    }
    setError('');
    setClientTrustChoices({ email, phone });
    const strategy: ClientTrustStrategy = email ? 'email_code' : 'phone_code';
    setClientTrustStrategy(strategy);
    setClientTrustCode('');
    setStep('client-trust');
    await sendClientTrustCode(strategy);
  };
  const handleClientTrustSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signIn || !clientTrustCode.trim()) return;
    setIsClientTrustLoading(true);
    setError('');
    try {
      const result = await signIn.attemptFirstFactor({
        strategy: clientTrustStrategy,
        code: clientTrustCode.trim(),
      });
      if (result.status === 'complete') {
        await navigate(result.createdSessionId, email);
      } else if (result.status === 'needs_second_factor') {
        enterMfaStep('credentials');
      } else {
        setError(t('auth.clientTrust.invalidCode'));
      }
    } catch (err: unknown) {
      const message = resolveClerkError(err, 'signIn', t);
      if (message === '__SESSION_EXISTS__') {
        window.location.href = getRedirectTarget(email).path;
        return;
      }
      setError(clerkErrorMessage(err, t('auth.clientTrust.invalidCode')));
    } finally {
      setIsClientTrustLoading(false);
    }
  };
  const goBack = () => {
    setError('');
    setResetCode('');
    setNewPassword('');
    setConfirmPassword('');
    setStep('credentials');
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signIn || !mfaCode.trim()) return;
    setIsMfaLoading(true);
    setError('');
    try {
      const result = await signIn.attemptSecondFactor({
        strategy: mfaStrategy,
        code: mfaCode.trim(),
      });
      if (result.status === 'complete') {
        await navigate(
          result.createdSessionId,
          mfaReturnStep === 'credentials' ? email : resetEmail,
        );
      } else if (result.status === 'needs_second_factor') {
        setError(t('auth.mfa.invalidCode'));
      } else {
        setError(t('auth.errors.signInInvalid'));
      }
    } catch (err: unknown) {
      const message = resolveClerkError(err, 'signIn', t);
      if (message === '__SESSION_EXISTS__') {
        window.location.href = getRedirectTarget(
          mfaReturnStep === 'credentials' ? email : resetEmail,
        ).path;
        return;
      }
      setError(clerkErrorMessage(err, t('auth.mfa.invalidCode')));
    } finally {
      setIsMfaLoading(false);
    }
  };

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signIn || !email || !password) return;
    setIsLoading(true);
    setError('');
    try {
      const result = await signIn.create({ identifier: email, password });
      if (result.status === 'complete') {
        await navigate(result.createdSessionId, email);
      } else if (result.status === 'needs_second_factor') {
        enterMfaStep('credentials');
      } else if (result.status === 'needs_client_trust') {
        // A device Clerk has not seen before, not a wrong password. Handled
        // at the source: `resolveClerkError`'s catch-all would otherwise
        // report this as "Incorrect email or password", which it is not.
        await enterClientTrustStep();
      } else {
        setError(t('auth.errors.signInInvalid'));
      }
    } catch (err: unknown) {
      const message = resolveClerkError(err, 'signIn', t);
      if (message === '__SESSION_EXISTS__') {
        window.location.href = getRedirectTarget(email).path;
        return;
      }
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotSend = async () => {
    if (!signIn || !resetEmail) return;
    setIsResetLoading(true);
    setError('');
    try {
      await signIn.create({
        strategy: 'reset_password_email_code',
        identifier: resetEmail,
      });
      setStep('forgot-code');
    } catch (err: unknown) {
      setError(clerkErrorMessage(err, t('auth.errors.somethingWentWrong')));
    } finally {
      setIsResetLoading(false);
    }
  };
  const handleForgotReset = async () => {
    if (!signIn || !resetCode || !newPassword) return;
    if (newPassword !== confirmPassword) {
      setError(t('auth.forgotPassword.passwordsDoNotMatch'));
      return;
    }
    setIsResetLoading(true);
    setError('');
    try {
      const result = await signIn.attemptFirstFactor({
        strategy: 'reset_password_email_code',
        code: resetCode,
        password: newPassword,
      });
      if (result.status === 'complete') {
        await navigate(result.createdSessionId, resetEmail);
      } else if (result.status === 'needs_second_factor') {
        enterMfaStep('forgot-code');
      }
    } catch (err: unknown) {
      setError(clerkErrorMessage(err, t('auth.forgotPassword.invalidCode')));
    } finally {
      setIsResetLoading(false);
    }
  };
  const handleForgotResend = async () => {
    if (!signIn || !resetEmail) return;
    setIsResetLoading(true);
    setError('');
    try {
      await signIn.create({
        strategy: 'reset_password_email_code',
        identifier: resetEmail,
      });
    } catch (err: unknown) {
      setError(clerkErrorMessage(err, t('auth.errors.somethingWentWrong')));
    } finally {
      setIsResetLoading(false);
    }
  };

  /* ── MFA step ── */
  if (step === 'mfa') {
    const hint =
      mfaStrategy === 'totp'
        ? t('auth.mfa.totpHint')
        : t('auth.mfa.backupHint');
    const showToggle = mfaChoices.totp && mfaChoices.backup;
    return (
      <div className="w-full">
        <div id="clerk-captcha" />
        <div className="space-y-4">
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold">{t('auth.mfa.title')}</h2>
            <p className="text-sm text-muted-foreground">{hint}</p>
          </div>
          {showToggle ? (
            <div className="flex rounded-lg border border-white/40 p-1 bg-white/50 dark:border-white/15 dark:bg-[var(--surface-2)]/60">
              <button
                type="button"
                onClick={() => {
                  setMfaStrategy('totp');
                  setMfaCode('');
                  setError('');
                }}
                className={
                  mfaStrategy === 'totp'
                    ? 'flex-1 rounded-md bg-[var(--purple)]/15 py-2 text-sm font-medium text-foreground'
                    : 'flex-1 rounded-md py-2 text-sm font-medium text-muted-foreground hover:text-foreground'
                }
              >
                {t('auth.mfa.useAuthenticatorApp')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMfaStrategy('backup_code');
                  setMfaCode('');
                  setError('');
                }}
                className={
                  mfaStrategy === 'backup_code'
                    ? 'flex-1 rounded-md bg-[var(--purple)]/15 py-2 text-sm font-medium text-foreground'
                    : 'flex-1 rounded-md py-2 text-sm font-medium text-muted-foreground hover:text-foreground'
                }
              >
                {t('auth.mfa.useBackupCode')}
              </button>
            </div>
          ) : null}
          <form onSubmit={handleMfaSubmit} className="flex flex-col gap-4">
            <div className="space-y-2">
              <Label htmlFor="mfa-code">{t('auth.mfa.codeLabel')}</Label>
              <FieldInput
                id="mfa-code"
                type="text"
                inputMode={mfaStrategy === 'totp' ? 'numeric' : 'text'}
                autoComplete={mfaStrategy === 'totp' ? 'one-time-code' : 'off'}
                placeholder={
                  mfaStrategy === 'totp'
                    ? t('auth.mfa.codePlaceholder.totp')
                    : t('auth.mfa.codePlaceholder.backup')
                }
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                className={FIELD_CLS}
                autoFocus
              />
            </div>
            {error ? (
              <p
                role="alert"
                className="text-xs leading-snug text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            ) : null}
            <SubmitButton
              type="submit"
              disabled={isMfaLoading || !mfaCode.trim()}
            >
              {isMfaLoading ? t('auth.mfa.verifying') : t('auth.mfa.verify')}
            </SubmitButton>
            <button
              type="button"
              onClick={goBackFromMfa}
              className="inline-flex items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              <IconArrowLeft />
              {t('auth.mfa.back')}
            </button>
          </form>
        </div>
      </div>
    );
  }

  /* ── Client Trust: verify this device (a first factor, not MFA) ── */
  if (step === 'client-trust') {
    const hint =
      clientTrustStrategy === 'email_code'
        ? t('auth.clientTrust.emailHint')
        : t('auth.clientTrust.phoneHint');
    const showToggle = clientTrustChoices.email && clientTrustChoices.phone;
    return (
      <div className="w-full">
        <div id="clerk-captcha" />
        <div className="space-y-4">
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold">
              {t('auth.clientTrust.title')}
            </h2>
            <p className="text-sm text-muted-foreground">{hint}</p>
          </div>
          {showToggle ? (
            <div className="flex rounded-lg border border-white/40 p-1 bg-white/50 dark:border-white/15 dark:bg-[var(--surface-2)]/60">
              <button
                type="button"
                onClick={() => {
                  setClientTrustStrategy('email_code');
                  setClientTrustCode('');
                  setError('');
                  void sendClientTrustCode('email_code');
                }}
                className={
                  clientTrustStrategy === 'email_code'
                    ? 'flex-1 rounded-md bg-[var(--purple)]/15 py-2 text-sm font-medium text-foreground'
                    : 'flex-1 rounded-md py-2 text-sm font-medium text-muted-foreground hover:text-foreground'
                }
              >
                {t('auth.clientTrust.useEmail')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setClientTrustStrategy('phone_code');
                  setClientTrustCode('');
                  setError('');
                  void sendClientTrustCode('phone_code');
                }}
                className={
                  clientTrustStrategy === 'phone_code'
                    ? 'flex-1 rounded-md bg-[var(--purple)]/15 py-2 text-sm font-medium text-foreground'
                    : 'flex-1 rounded-md py-2 text-sm font-medium text-muted-foreground hover:text-foreground'
                }
              >
                {t('auth.clientTrust.usePhone')}
              </button>
            </div>
          ) : null}
          <form
            onSubmit={handleClientTrustSubmit}
            className="flex flex-col gap-4"
          >
            <div className="space-y-2">
              <Label htmlFor="client-trust-code">
                {t('auth.clientTrust.codeLabel')}
              </Label>
              <FieldInput
                id="client-trust-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                placeholder={t('auth.clientTrust.codePlaceholder')}
                value={clientTrustCode}
                onChange={(e) => setClientTrustCode(e.target.value)}
                className={FIELD_CLS}
                autoFocus
              />
            </div>
            {error ? (
              <p
                role="alert"
                className="text-xs leading-snug text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            ) : null}
            <SubmitButton
              type="submit"
              disabled={isClientTrustLoading || !clientTrustCode.trim()}
            >
              {isClientTrustLoading
                ? t('auth.clientTrust.verifying')
                : t('auth.clientTrust.verify')}
            </SubmitButton>
            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={() => void sendClientTrustCode(clientTrustStrategy)}
                disabled={isClientTrustLoading}
                className="text-sm text-[var(--fs-ink-dim)] hover:text-gray-900 dark:hover:text-gray-200 hover:underline"
              >
                {t('auth.clientTrust.resendCode')}
              </button>
              <button
                type="button"
                onClick={goBackFromClientTrust}
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline"
              >
                <IconArrowLeft />
                {t('auth.clientTrust.back')}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  /* ── Forgot: send code ── */
  if (step === 'forgot') {
    const emailIsValid = isValidEmail(resetEmail);
    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <h2 className="text-2xl font-semibold">
            {t('auth.forgotPassword.title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('auth.forgotPassword.description')}
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!emailIsValid || isResetLoading) return;
            handleForgotSend();
          }}
          noValidate
          className="flex flex-col space-y-5"
        >
          <div className="space-y-2">
            <Label htmlFor="resetEmail">{t('auth.email')}</Label>
            <FieldInput
              id="resetEmail"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder={t('auth.email.placeholder')}
              value={resetEmail}
              onChange={(e) => setResetEmail(e.target.value)}
              className={FIELD_CLS}
              required
            />
          </div>
          {error && <div className="text-red-400 text-xs mt-1">{error}</div>}
          <SubmitButton
            type="submit"
            disabled={isResetLoading || !emailIsValid}
            className="mt-4"
          >
            {isResetLoading
              ? t('auth.forgotPassword.sendingCode')
              : t('auth.forgotPassword.sendCode')}
          </SubmitButton>
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            <IconArrowLeft />
            {t('auth.forgotPassword.backToSignIn')}
          </button>
        </form>
      </div>
    );
  }

  /* ── Forgot: reset ── */
  if (step === 'forgot-code') {
    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <h2 className="text-2xl font-semibold">
            {t('auth.forgotPassword.title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('auth.forgotPassword.description')}
          </p>
        </div>
        <div className="flex flex-col space-y-5">
          <div className="space-y-2">
            <Label htmlFor="resetCode">
              {t('auth.forgotPassword.enterCode')}
            </Label>
            <FieldInput
              id="resetCode"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="123456"
              value={resetCode}
              onChange={(e) => setResetCode(e.target.value)}
              className={FIELD_CLS}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="newPassword">
              {t('auth.forgotPassword.newPassword')}
            </Label>
            <div className="relative">
              <FieldInput
                id="newPassword"
                type={showNewPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={`${FIELD_CLS} pr-12`}
              />
              {newPassword && (
                <button
                  type="button"
                  onClick={() => setShowNewPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={
                    showNewPassword ? 'Hide password' : 'Show password'
                  }
                >
                  {showNewPassword ? <IconEyeOff /> : <IconEye />}
                </button>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirmPassword">
              {t('auth.forgotPassword.confirmPassword')}
            </Label>
            <div className="relative">
              <FieldInput
                id="confirmPassword"
                type={showConfirmPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={`${FIELD_CLS} pr-12`}
              />
              {confirmPassword && (
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={
                    showConfirmPassword ? 'Hide password' : 'Show password'
                  }
                >
                  {showConfirmPassword ? <IconEyeOff /> : <IconEye />}
                </button>
              )}
            </div>
          </div>
          {error && <div className="text-red-400 text-xs mt-1">{error}</div>}
          <SubmitButton
            type="button"
            onClick={handleForgotReset}
            disabled={
              isResetLoading || !resetCode || !newPassword || !confirmPassword
            }
            className="mt-4"
          >
            {isResetLoading
              ? t('auth.forgotPassword.resettingPassword')
              : t('auth.forgotPassword.resetPassword')}
          </SubmitButton>
          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={handleForgotResend}
              disabled={isResetLoading}
              className="text-sm text-[var(--fs-ink-dim)] hover:text-gray-900 dark:hover:text-gray-200 hover:underline"
            >
              {t('auth.forgotPassword.resendCode')}
            </button>
            <button
              type="button"
              onClick={goBack}
              className="inline-flex items-center gap-1.5 text-sm text-[var(--fs-ink-dim)] hover:text-gray-900 dark:hover:text-gray-200 hover:underline"
            >
              <IconArrowLeft />
              {t('auth.forgotPassword.backToSignIn')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ── Credentials step ── */
  const emailIsValid = isValidEmail(email);
  return (
    <div className="w-full">
      <div id="clerk-captcha" />
      <form onSubmit={handleCredentialsSubmit} className="flex flex-col gap-4">
        <div className="space-y-2">
          <Label htmlFor="email">
            {isTeam ? t('team.login.emailLabel') : t('auth.email')}
          </Label>
          <FieldInput
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            placeholder={
              isTeam
                ? t('team.login.emailPlaceholder')
                : t('auth.email.placeholder')
            }
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={FIELD_CLS}
            required
            autoFocus={isTeam}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">
            {isTeam ? t('team.login.passwordLabel') : t('auth.password')}
          </Label>
          <div className="relative">
            <FieldInput
              id="password"
              type={showPassword ? 'text' : 'password'}
              placeholder={
                isTeam
                  ? t('team.login.passwordPlaceholder')
                  : t('auth.password.placeholder')
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`${FIELD_CLS} pr-12`}
              required
            />
            {(isTeam || !isEdgeBrowser) && password && (
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <IconEyeOff /> : <IconEye />}
              </button>
            )}
          </div>
          <div className="flex justify-end mt-1">
            <button
              type="button"
              onClick={() => {
                setStep('forgot');
                setResetEmail(email);
              }}
              className="text-sm text-[var(--fs-ink-dim)] hover:text-[var(--fs-ink)] hover:underline"
            >
              {t('auth.forgotPassword')}
            </button>
          </div>
          {error ? (
            <p
              role="alert"
              className="text-xs leading-snug text-red-600 dark:text-red-400"
            >
              {error}
            </p>
          ) : null}
        </div>
        <SubmitButton
          type="submit"
          disabled={isLoading || !emailIsValid || !password}
        >
          {isLoading
            ? isTeam
              ? t('team.login.signingIn')
              : t('auth.signIn.signingIn')
            : isTeam
              ? t('team.login.signIn')
              : t('auth.signIn')}
        </SubmitButton>
      </form>
    </div>
  );
}
