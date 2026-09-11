/**
 * The liquid glass primitives, and the one visual rule the client dashboard
 * adds on top of them.
 *
 * `packages/flow-design-system` has no test runner, so its components are
 * exercised from the app that consumes them. That is also the honest place to
 * test them: what matters is that the app's tiles keep the attributes the page
 * tests assert on while picking up the tone the design system paints.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GlassSurface } from '@flowstarter/flow-design-system/components/surfaces/GlassSurface';
import { StatTile } from '@flowstarter/flow-design-system/components/surfaces/StatTile';
import { MeshBackdrop } from '@flowstarter/flow-design-system/components/backgrounds/MeshBackdrop';
import { tilePalette } from '../SiteOverview';
import type { SiteOverviewTile } from '../site-overview';

function tile(overrides: Partial<SiteOverviewTile> = {}): SiteOverviewTile {
  return {
    key: 'credits',
    label: 'Edits',
    value: '9 of 10',
    note: 'Edits left this month.',
    tone: 'ok',
    ...overrides,
  };
}

describe('GlassSurface', () => {
  it('renders the element it was asked for, so a panel can be a section', () => {
    render(
      <GlassSurface as="section" variant="panel" data-testid="surface">
        body
      </GlassSurface>
    );

    const surface = screen.getByTestId('surface');
    expect(surface.tagName).toBe('SECTION');
    expect(surface.className).toContain('fs-glass');
    expect(surface.className).toContain('fs-glass--panel');
  });

  it('only carries the tone classes when a tone was asked for', () => {
    const { rerender } = render(
      <GlassSurface data-testid="surface">body</GlassSurface>
    );
    expect(screen.getByTestId('surface').className).not.toContain(
      'fs-glass--toned'
    );
    expect(screen.getByTestId('surface')).not.toHaveAttribute('data-tone');

    rerender(
      <GlassSurface tone="violet" data-testid="surface">
        body
      </GlassSurface>
    );
    expect(screen.getByTestId('surface').className).toContain(
      'fs-glass--toned'
    );
    expect(screen.getByTestId('surface')).toHaveAttribute(
      'data-tone',
      'violet'
    );
  });

  it('adds the hover lift only when the whole surface is interactive', () => {
    const { rerender } = render(
      <GlassSurface data-testid="surface">body</GlassSurface>
    );
    expect(screen.getByTestId('surface').className).not.toContain(
      'fs-glass--interactive'
    );

    rerender(
      <GlassSurface interactive data-testid="surface">
        body
      </GlassSurface>
    );
    expect(screen.getByTestId('surface').className).toContain(
      'fs-glass--interactive'
    );
  });
});

describe('StatTile', () => {
  it('prints the label, the value and the note, and tags the tone twice', () => {
    render(
      <StatTile
        label="Enquiries"
        value="12"
        note="In the last 30 days."
        tone="info"
      />
    );

    expect(screen.getByText('Enquiries')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('In the last 30 days.')).toBeInTheDocument();

    const value = screen.getByText('12');
    expect(value.className).toContain('fs-glass-tile__value');
    // Both attributes carry the tone by default; the app overrides only one.
    const surface = value.closest('.fs-glass-tile');
    expect(surface).toHaveAttribute('data-tone', 'info');
    expect(surface).toHaveAttribute('data-palette', 'info');
  });

  it('renders the same body with and without a link, and only swaps the wrapper', () => {
    const { container: plain } = render(
      <StatTile
        label="Bookings"
        value="Connected"
        note="Straight to your calendar."
      />
    );
    const { container: linked } = render(
      <StatTile
        label="Bookings"
        value="Connected"
        note="Straight to your calendar."
        href="/dashboard/projects/x/booking"
      />
    );

    const plainTile = plain.querySelector('.fs-glass-tile') as HTMLElement;
    const linkedTile = linked.querySelector('.fs-glass-tile') as HTMLElement;

    expect(plainTile.tagName).toBe('DIV');
    expect(linkedTile.tagName).toBe('A');
    expect(linkedTile).toHaveAttribute('href', '/dashboard/projects/x/booking');
    expect(linkedTile.innerHTML).toBe(plainTile.innerHTML);
  });

  it('renders through an injected link component, so Next Link can be used', () => {
    function FakeLink({
      href,
      children,
      ...rest
    }: {
      href: string;
      children?: React.ReactNode;
    }) {
      return (
        <a href={href} data-link="injected" {...rest}>
          {children}
        </a>
      );
    }

    render(
      <StatTile
        label="Edits"
        value="4"
        href="/editor"
        linkComponent={FakeLink}
        tone="accent"
      />
    );

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('data-link', 'injected');
    expect(link).toHaveAttribute('data-palette', 'accent');
  });

  it('drops the note and the icon entirely rather than rendering empty nodes', () => {
    const { container } = render(<StatTile label="Edits" value="4" />);
    expect(container.querySelector('.fs-glass-tile__note')).toBeNull();
    expect(container.querySelector('.fs-glass-tile__icon')).toBeNull();
  });

  it('passes data attributes through so a caller can keep its own data-tone', () => {
    render(
      <StatTile
        label="Enquiries"
        value="0"
        tone="neutral"
        data-testid="site-overview-tile"
        data-key="enquiries"
        data-tone="muted"
      />
    );

    const el = screen.getByTestId('site-overview-tile');
    expect(el).toHaveAttribute('data-key', 'enquiries');
    // The caller's meaning wins on data-tone; the paint stays on data-palette.
    expect(el).toHaveAttribute('data-tone', 'muted');
    expect(el).toHaveAttribute('data-palette', 'neutral');
  });
});

describe('MeshBackdrop', () => {
  it('is decorative and carries its variant as data, not as a class', () => {
    const { container } = render(<MeshBackdrop variant="editor" />);
    const mesh = container.firstElementChild as HTMLElement;

    expect(mesh.className).toBe('fs-mesh-backdrop');
    expect(mesh).toHaveAttribute('data-variant', 'editor');
    expect(mesh).toHaveAttribute('aria-hidden', 'true');
  });

  it('defaults to the app variant', () => {
    const { container } = render(<MeshBackdrop />);
    expect(container.firstElementChild).toHaveAttribute('data-variant', 'app');
  });
});

describe('tilePalette', () => {
  it('gives each subject its own colour when the rules are content', () => {
    expect(tilePalette(tile({ key: 'credits', tone: 'ok' }))).toBe('accent');
    expect(tilePalette(tile({ key: 'enquiries', tone: 'ok' }))).toBe('info');
    expect(tilePalette(tile({ key: 'bookings', tone: 'ok' }))).toBe('teal');
    expect(tilePalette(tile({ key: 'changes', tone: 'ok' }))).toBe('violet');
    expect(tilePalette(tile({ key: 'store', tone: 'ok' }))).toBe('ok');
  });

  it('lets the rules outrank the subject', () => {
    // "There is something for you to do" is amber whatever the tile is about.
    expect(tilePalette(tile({ key: 'credits', tone: 'attention' }))).toBe(
      'warn'
    );
    expect(tilePalette(tile({ key: 'bookings', tone: 'attention' }))).toBe(
      'warn'
    );
    // "Not switched on yet" is colourless whatever the tile is about.
    expect(tilePalette(tile({ key: 'enquiries', tone: 'muted' }))).toBe(
      'neutral'
    );
    expect(tilePalette(tile({ key: 'store', tone: 'muted' }))).toBe('neutral');
  });

  it('never reaches for danger, because none of these states is a failure', () => {
    const every: SiteOverviewTile[] = (
      ['credits', 'enquiries', 'bookings', 'changes', 'store'] as const
    ).flatMap((key) =>
      (['ok', 'attention', 'muted'] as const).map((tone) => tile({ key, tone }))
    );

    for (const candidate of every) {
      expect(tilePalette(candidate)).not.toBe('danger');
    }
  });
});
