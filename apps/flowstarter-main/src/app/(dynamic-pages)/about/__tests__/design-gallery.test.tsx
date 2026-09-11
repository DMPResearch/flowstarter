/**
 * The design gallery is dev-only tooling, and the one thing that has to be
 * true about it is that a production build can never serve it. These tests
 * prove the `notFound()` gate and that, when it is open, both fixture
 * sections the gallery promises actually render.
 */
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import DesignGalleryPage from '../design-gallery/page';

class NotFoundSignal extends Error {}

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSignal('notFound');
  },
  usePathname: () => '/about/design-gallery',
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@clerk/nextjs', () => ({
  useUser: () => ({ user: null, isLoaded: true }),
  useClerk: () => ({ signOut: vi.fn() }),
}));

// jsdom has no `matchMedia`; `ThemeContext` reaches for it as soon as the
// admin section mounts (its "theme follows the system" listener).
beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the design gallery gate', () => {
  it('404s outside development without the opt-in flag', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FLOWSTARTER_DESIGN_GALLERY', '');

    expect(() => render(<DesignGalleryPage />)).toThrow(NotFoundSignal);
  });

  it('renders in production when the opt-in flag is set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FLOWSTARTER_DESIGN_GALLERY', '1');

    render(<DesignGalleryPage />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Design gallery' })
    ).toBeInTheDocument();
  });

  it('renders both fixture sections in development', () => {
    vi.stubEnv('NODE_ENV', 'development');

    render(<DesignGalleryPage />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Client dashboard' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Admin' })
    ).toBeInTheDocument();
  });

  it('feeds the rules module real inputs instead of hardcoding the tile copy', () => {
    vi.stubEnv('NODE_ENV', 'development');

    render(<DesignGalleryPage />);

    // Starter, 4 of 50 used this month: the rules module derives "46 of 50".
    expect(screen.getByText(/46 of 50/)).toBeInTheDocument();
    // Ecommerce, 12 of 150 used this month: derives "138 of 150".
    expect(screen.getByText(/138 of 150/)).toBeInTheDocument();
  });

  it('renders the admin fixture rows and the three badge tones', () => {
    vi.stubEnv('NODE_ENV', 'development');

    render(<DesignGalleryPage />);

    expect(screen.getByText('Acme Dental')).toBeInTheDocument();
    expect(screen.getByText('Riverside Vets')).toBeInTheDocument();
    expect(screen.getByText('Blue Anchor Cafe')).toBeInTheDocument();
    expect(screen.getByText('Whitmore Legal')).toBeInTheDocument();

    const badges = within(screen.getByTestId('design-gallery-badges'));
    expect(badges.getByText('All good')).toBeInTheDocument();
    expect(badges.getByText('Needs attention')).toBeInTheDocument();
    expect(badges.getByText('Not started')).toBeInTheDocument();
  });
});
