import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useContactForm } from '../useContactForm';
import React from 'react';

global.fetch = vi.fn();

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('useContactForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should submit contact form successfully', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        ok: true,
        json: async () => ({ success: true }),
      }
    );

    const { result } = renderHook(() => useContactForm(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      name: 'John Doe',
      email: 'john@example.com',
      subject: 'General',
      message: 'Hello, I have a question.',
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.success).toBe(true);

    expect(global.fetch).toHaveBeenCalledWith('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'John Doe',
        email: 'john@example.com',
        subject: 'General',
        message: 'Hello, I have a question.',
      }),
    });
  });

  it('should handle submission error', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        ok: false,
        json: async () => ({ error: 'Invalid email' }),
      }
    );

    const { result } = renderHook(() => useContactForm(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      name: 'John',
      email: 'invalid',
      subject: 'General',
      message: 'Test',
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe('Invalid email');
  });

  it('should include optional company field', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        ok: true,
        json: async () => ({ success: true }),
      }
    );

    const { result } = renderHook(() => useContactForm(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      name: 'Jane Doe',
      email: 'jane@company.com',
      subject: 'Project',
      company: 'Acme Inc',
      message: 'Partnership inquiry',
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/contact',
      expect.objectContaining({
        body: expect.stringContaining('Acme Inc'),
      })
    );
  });
});
