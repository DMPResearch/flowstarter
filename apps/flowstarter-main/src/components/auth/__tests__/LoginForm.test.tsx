import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── Mocks ──────────────────────────────────────────────────────────────────

const clerkMocks = vi.hoisted(() => ({
  create: vi.fn(),
  prepareFirstFactor: vi.fn(),
  attemptFirstFactor: vi.fn(),
  attemptSecondFactor: vi.fn(),
  setActive: vi.fn(),
  supportedSecondFactors: null as Array<{ strategy: string }> | null,
  supportedFirstFactors: null as Array<{
    strategy: string;
    emailAddressId?: string;
    phoneNumberId?: string;
  }> | null,
}));

vi.mock('@clerk/nextjs/legacy', () => ({
  useSignIn: () => ({
    signIn: {
      create: clerkMocks.create,
      prepareFirstFactor: clerkMocks.prepareFirstFactor,
      attemptFirstFactor: clerkMocks.attemptFirstFactor,
      attemptSecondFactor: clerkMocks.attemptSecondFactor,
      get supportedSecondFactors() {
        return clerkMocks.supportedSecondFactors;
      },
      get supportedFirstFactors() {
        return clerkMocks.supportedFirstFactors;
      },
    },
    setActive: clerkMocks.setActive,
  }),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: () => null,
  }),
}));

vi.mock('@/lib/i18n', () => ({
  useTranslations: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@flowstarter/platform-config', () => ({
  isTrustedHost: () => false,
  isTeamEmail: () => false,
}));

vi.mock('../hooks', () => ({
  useClerkErrorHandler: () => ({
    handleError: vi.fn(() => 'error'),
  }),
  useEdgeBrowserDetection: () => false,
}));

vi.mock('../ForgotPasswordFlow', () => ({
  ForgotPasswordSend: () => <div data-testid="forgot-send" />,
  ForgotPasswordReset: () => <div data-testid="forgot-reset" />,
}));

import { LoginForm } from '../LoginForm';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clerkMocks.supportedSecondFactors = null;
    clerkMocks.supportedFirstFactors = null;
    clerkMocks.create.mockReset();
    clerkMocks.prepareFirstFactor.mockReset();
    clerkMocks.attemptFirstFactor.mockReset();
    clerkMocks.attemptSecondFactor.mockReset();
    clerkMocks.setActive.mockReset();
  });

  it('renders email and password inputs', () => {
    render(<LoginForm variant="client" />);

    const emailInput = screen.getByRole('textbox');
    expect(emailInput).toBeInTheDocument();
    expect(emailInput).toHaveAttribute('type', 'email');

    // password input does not have role=textbox, find by id
    const passwordInput = document.getElementById('password');
    expect(passwordInput).toBeInTheDocument();
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('renders submit button', () => {
    render(<LoginForm variant="client" />);

    // The submit button text comes from t() which returns the key
    const btn = screen.getByRole('button', { name: /auth\.signIn$/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('type', 'submit');
  });

  it('shows "forgot password" link for the client variant', () => {
    render(<LoginForm variant="client" />);

    const forgotBtn = screen.getByText('auth.forgotPassword');
    expect(forgotBtn).toBeInTheDocument();
  });

  it('shows "forgot password" link for the team variant', () => {
    render(<LoginForm variant="team" />);

    const forgotBtn = screen.getByText('auth.forgotPassword');
    expect(forgotBtn).toBeInTheDocument();
  });

  it('does not render any social-auth buttons (Google/Apple removed for MVP)', () => {
    render(<LoginForm variant="client" />);

    expect(screen.queryByText('auth.google')).not.toBeInTheDocument();
    expect(screen.queryByText('auth.apple')).not.toBeInTheDocument();
  });

  it('shows MFA step when password sign-in requires second factor (TOTP)', async () => {
    clerkMocks.supportedSecondFactors = [{ strategy: 'totp' }];
    clerkMocks.create.mockResolvedValue({
      status: 'needs_second_factor',
      createdSessionId: null,
    });

    render(<LoginForm variant="client" />);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(document.getElementById('password')!, {
      target: { value: 'secretpass' },
    });
    fireEvent.click(screen.getByRole('button', { name: /auth\.signIn$/i }));

    await waitFor(() => {
      expect(screen.getByText('auth.mfa.title')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('auth.mfa.codeLabel')).toBeInTheDocument();
  });

  it('shows unsupported message when second factor is not TOTP or backup code', async () => {
    clerkMocks.supportedSecondFactors = [{ strategy: 'phone_code' }];
    clerkMocks.create.mockResolvedValue({
      status: 'needs_second_factor',
      createdSessionId: null,
    });

    render(<LoginForm variant="client" />);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(document.getElementById('password')!, {
      target: { value: 'secretpass' },
    });
    fireEvent.click(screen.getByRole('button', { name: /auth\.signIn$/i }));

    await waitFor(() => {
      expect(
        screen.getByText('auth.mfa.unsupportedFactor')
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('auth.mfa.title')).not.toBeInTheDocument();
  });

  it('shows the Client Trust step, not "incorrect password", when a new device needs verifying', async () => {
    clerkMocks.supportedFirstFactors = [
      { strategy: 'email_code', emailAddressId: 'idn_1' },
    ];
    clerkMocks.create.mockResolvedValue({
      status: 'needs_client_trust',
      createdSessionId: null,
    });

    render(<LoginForm variant="client" />);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(document.getElementById('password')!, {
      target: { value: 'secretpass' },
    });
    fireEvent.click(screen.getByRole('button', { name: /auth\.signIn$/i }));

    await waitFor(() => {
      expect(screen.getByText('auth.clientTrust.title')).toBeInTheDocument();
    });
    expect(
      screen.getByLabelText('auth.clientTrust.codeLabel')
    ).toBeInTheDocument();
    // The whole point of the fix: this status must never surface as a
    // wrong-password message, which it is not.
    expect(screen.queryByText('auth.errors.signInInvalid')).toBeNull();
    // The code was sent (prepared) as soon as the step opened, the way
    // the forgot-password email code already does.
    expect(clerkMocks.prepareFirstFactor).toHaveBeenCalledWith({
      strategy: 'email_code',
      emailAddressId: 'idn_1',
    });
  });

  it('completes sign-in once the Client Trust code is verified', async () => {
    clerkMocks.supportedFirstFactors = [
      { strategy: 'email_code', emailAddressId: 'idn_1' },
    ];
    clerkMocks.create.mockResolvedValue({
      status: 'needs_client_trust',
      createdSessionId: null,
    });
    clerkMocks.attemptFirstFactor.mockResolvedValue({
      status: 'complete',
      createdSessionId: 'sess_1',
    });

    render(<LoginForm variant="client" />);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(document.getElementById('password')!, {
      target: { value: 'secretpass' },
    });
    fireEvent.click(screen.getByRole('button', { name: /auth\.signIn$/i }));

    await waitFor(() => {
      expect(
        screen.getByLabelText('auth.clientTrust.codeLabel')
      ).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('auth.clientTrust.codeLabel'), {
      target: { value: '424242' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /auth\.clientTrust\.verify$/i })
    );

    await waitFor(() => {
      expect(clerkMocks.attemptFirstFactor).toHaveBeenCalledWith({
        strategy: 'email_code',
        code: '424242',
      });
    });
    expect(clerkMocks.setActive).toHaveBeenCalledWith({ session: 'sess_1' });
  });

  it('reports the device as needing verification when neither an email nor a phone code is offered', async () => {
    clerkMocks.supportedFirstFactors = [];
    clerkMocks.create.mockResolvedValue({
      status: 'needs_client_trust',
      createdSessionId: null,
    });

    render(<LoginForm variant="client" />);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(document.getElementById('password')!, {
      target: { value: 'secretpass' },
    });
    fireEvent.click(screen.getByRole('button', { name: /auth\.signIn$/i }));

    await waitFor(() => {
      expect(
        screen.getByText('auth.clientTrust.unsupportedFactor')
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText('auth.clientTrust.title')
    ).not.toBeInTheDocument();
    expect(clerkMocks.prepareFirstFactor).not.toHaveBeenCalled();
  });
});
