/**
 * The preview pane beside the intake conversation.
 *
 * The rules are covered in `preview-skeleton.test.ts`; this covers the part a
 * pure function cannot, which is that the pane actually draws what the rules
 * decided and that the fact list's pencils send the conversation back to the
 * right question. Everything here is derived, so nothing is stubbed: there is
 * no fetch to stub.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_DISCOVERY, type DiscoveryData } from '../discovery.logic';
import { IntakePreviewPane, KnownSoFar } from '../steps/IntakePreviewPane';

/** The catalogue is not under test here; the key is the label. */
const t = (key: string) => key;

function data(overrides: Partial<DiscoveryData> = {}): DiscoveryData {
  return { ...EMPTY_DISCOVERY, ...overrides };
}

describe('IntakePreviewPane', () => {
  it('shows the business name in the header and the hero once it is given', () => {
    render(
      <IntakePreviewPane data={data({ businessName: 'Sable Fig' })} t={t} />
    );
    expect(screen.getByTestId('preview-header-name')).toHaveTextContent(
      'Sable Fig'
    );
    expect(screen.getByTestId('preview-hero-name')).toHaveTextContent(
      'Sable Fig'
    );
  });

  it('shows bars rather than an invented name before the visitor answers', () => {
    render(<IntakePreviewPane data={data()} t={t} />);
    expect(screen.queryByTestId('preview-header-name')).toBeNull();
    expect(screen.queryByTestId('preview-hero-name')).toBeNull();
  });

  it('changes its sections with the industry answer', () => {
    const { rerender } = render(<IntakePreviewPane data={data()} t={t} />);
    const sections = () =>
      screen.getByTestId('derived-site-skeleton').dataset.sections;

    expect(sections()).toContain('services');
    expect(sections()).not.toContain('menu');

    rerender(
      <IntakePreviewPane
        data={data({ industry: 'Hospitality & food' })}
        t={t}
      />
    );
    expect(sections()).toContain('menu');
    expect(sections()).not.toContain('services');
  });

  it('adds a product row when the commerce answer says there is a catalogue', () => {
    const { rerender } = render(<IntakePreviewPane data={data()} t={t} />);
    expect(screen.queryByTestId('preview-product-row')).toBeNull();

    rerender(
      <IntakePreviewPane data={data({ commerceMode: 'physical' })} t={t} />
    );
    expect(screen.getByTestId('preview-product-row')).toBeInTheDocument();
  });

  it('adds no product row for a business with only a few paid offers', () => {
    render(
      <IntakePreviewPane data={data({ commerceMode: 'few-services' })} t={t} />
    );
    expect(screen.queryByTestId('preview-product-row')).toBeNull();
  });

  it('widens the nav with the page count', () => {
    const navItems = () =>
      within(screen.getByTestId('preview-nav')).queryAllByRole('presentation')
        .length;
    const { rerender } = render(
      <IntakePreviewPane data={data({ pageCount: 'lt-5' })} t={t} />
    );
    const few = screen.getByTestId('preview-nav').childElementCount;

    rerender(<IntakePreviewPane data={data({ pageCount: '15+' })} t={t} />);
    const many = screen.getByTestId('preview-nav').childElementCount;

    expect(many).toBeGreaterThan(few);
    expect(navItems()).toBe(0); // the bars are decoration, not content
  });

  it('carries the tone answer as the skeleton weight and radius', () => {
    render(<IntakePreviewPane data={data({ brandTone: 'Bold' })} t={t} />);
    const frame = screen.getByTestId('derived-site-skeleton');
    expect(frame.dataset.weight).toBe('bold');
    expect(frame.dataset.radius).toBe('sharp');
  });
});

describe('KnownSoFar', () => {
  it('shows every fact as unknown before anything is answered', () => {
    render(<KnownSoFar data={data()} t={t} />);
    const list = screen.getByTestId('known-so-far');
    expect(list.querySelectorAll('[data-known="no"]').length).toBe(4);
    expect(list.querySelectorAll('[data-known="yes"]').length).toBe(0);
  });

  it('fills in as the answers land', () => {
    render(
      <KnownSoFar
        data={data({
          fullName: 'Ana',
          description: 'We roast single origin coffee.',
        })}
        t={t}
      />
    );
    const list = screen.getByTestId('known-so-far');
    expect(list.querySelectorAll('[data-known="yes"]').length).toBe(2);
    expect(list).toHaveTextContent('Ana');
    expect(list).toHaveTextContent('We roast single origin coffee.');
  });

  it('names the networks rather than printing the pasted links', () => {
    render(
      <KnownSoFar
        data={data({
          instagramUrl: 'https://instagram.com/sablefig',
          websiteUrl: 'https://sablefig.ro',
        })}
        t={t}
      />
    );
    const list = screen.getByTestId('known-so-far');
    expect(list).toHaveTextContent('Instagram, Website');
    expect(list).not.toHaveTextContent('instagram.com/sablefig');
  });

  it('offers an edit only for a fact the visitor has actually given', async () => {
    const onEdit = vi.fn();
    render(
      <KnownSoFar
        data={data({ description: 'We roast single origin coffee.' })}
        t={t}
        onEdit={onEdit}
      />
    );
    // One pencil, for the one answered fact.
    const pencils = screen.getAllByRole('button');
    expect(pencils).toHaveLength(1);

    await userEvent.click(pencils[0]);
    expect(onEdit).toHaveBeenCalledWith('description');
  });

  it('shows no pencils at all when the pane cannot route an edit', () => {
    render(<KnownSoFar data={data({ fullName: 'Ana' })} t={t} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
