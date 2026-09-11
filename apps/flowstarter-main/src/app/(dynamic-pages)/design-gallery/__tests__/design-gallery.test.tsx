/**
 * The design gallery is dev-only tooling, and the one thing that has to be
 * true about it is that a production build can never serve it. These tests
 * prove the `notFound()` gate and that, when it is open, both fixture
 * sections the gallery promises actually render.
 */
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import DesignGalleryPage from '../page';

class NotFoundSignal extends Error {}

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSignal('notFound');
  },
  usePathname: () => '/design-gallery',
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

  it('renders every fixture section in development', () => {
    vi.stubEnv('NODE_ENV', 'development');

    render(<DesignGalleryPage />);

    for (const name of [
      'Client dashboard',
      'Admin dashboard',
      'Admin pipeline',
    ]) {
      expect(
        screen.getByRole('heading', { level: 2, name })
      ).toBeInTheDocument();
    }
  });

  /**
   * The gallery exists to show a surface at the width it has in the product.
   * Under `/about` it inherited that page's `max-w-6xl` reading column and
   * the board lost roughly half its width, so nothing here may reintroduce a
   * max-width between the page and an admin embed.
   */
  it('renders the admin sections full-bleed, not in a reading column', () => {
    vi.stubEnv('NODE_ENV', 'development');

    const { container } = render(<DesignGalleryPage />);
    const board = screen.getByTestId('pipeline-board');

    for (
      let node: HTMLElement | null = board;
      node && node !== container;
      node = node.parentElement
    ) {
      expect(node.className).not.toMatch(/\bmax-w-/);
    }
  });

  it('feeds the rules module real inputs instead of hardcoding the tile copy', () => {
    vi.stubEnv('NODE_ENV', 'development');

    render(<DesignGalleryPage />);

    // Starter, 4 of 50 used this month: the rules module derives "46 of 50".
    expect(screen.getByText(/46 of 50/)).toBeInTheDocument();
    // Ecommerce, 12 of 150 used this month: derives "138 of 150".
    expect(screen.getByText(/138 of 150/)).toBeInTheDocument();
  });

  it('renders the admin fixture rows and the column-tone legend', () => {
    vi.stubEnv('NODE_ENV', 'development');

    render(<DesignGalleryPage />);

    // Scoped to the projects table itself: the Pipeline board underneath it
    // has its own fixture cards, deliberately different businesses, but nothing
    // stops a future edit to either fixture list from picking the same name —
    // an unscoped `getByText` would then throw on finding it twice rather than
    // proving this table rendered.
    const table = within(screen.getByTestId('design-gallery-projects-table'));
    expect(table.getByText('Acme Dental')).toBeInTheDocument();
    expect(table.getByText('Riverside Vets')).toBeInTheDocument();
    expect(table.getByText('Blue Anchor Cafe')).toBeInTheDocument();
    expect(table.getByText('Whitmore Legal')).toBeInTheDocument();

    // The legend names the six columns and nothing else: the three loose
    // Badge samples that used to sit here ("All good", "Needs attention",
    // "Not started") wore green, amber and grey under a board that uses
    // none of the three, and read as its key.
    const legend = within(screen.getByTestId('design-gallery-legend'));
    expect(legend.getByText('Column colour')).toBeInTheDocument();
    for (const state of [
      'Intake',
      'Preview ready',
      'Deposit paid',
      'Agents working',
      'Human QA',
      'Live',
    ]) {
      expect(legend.getByText(state)).toBeInTheDocument();
    }
  });

  it('renders the pipeline board with populated columns, one stalled', () => {
    vi.stubEnv('NODE_ENV', 'development');

    render(<DesignGalleryPage />);

    const board = within(screen.getByTestId('pipeline-board'));
    expect(board.getByRole('heading', { name: 'Intake' })).toBeInTheDocument();
    expect(
      board.getByRole('heading', { name: 'Agents working' })
    ).toBeInTheDocument();
    expect(board.getByText('1 stalled')).toBeInTheDocument();
    // The longest business name in the fixture set reads in full, not
    // clipped to an ellipsis.
    expect(board.getByText('Riverside Veterinary Clinic')).toBeInTheDocument();
  });
});
