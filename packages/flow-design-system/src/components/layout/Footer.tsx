'use client';

import type { ReactNode } from 'react';

export interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface FooterProps {
  copyright?: string;
  links?: FooterLink[];
  showClientLogin?: boolean;
  clientLoginLabel?: string;
  builtWithLabel?: string;
  byTeamLabel?: string;
  baseUrl?: string;
  renderLink?: (
    href: string,
    children: ReactNode,
    className?: string,
  ) => ReactNode;
}

const defaultLinks: FooterLink[] = [
  { label: 'Help', href: '/help' },
  { label: 'Blog', href: '/blog' },
  { label: 'Privacy', href: '/privacy' },
  { label: 'Terms', href: '/terms' },
  { label: 'Contact', href: '/contact' },
  { label: 'Team Dashboard', href: '/admin/dashboard' },
  { label: 'Editor', href: 'https://editor.flowstarter.dev', external: true },
];

const Dot = () => <span className="text-gray-300 dark:text-white/10">•</span>;

export function Footer({
  copyright,
  links = defaultLinks,
  showClientLogin = false,
  clientLoginLabel = 'Client Login',
  builtWithLabel = 'Built with',
  byTeamLabel = 'by the Flowstarter team',
  baseUrl = '',
  renderLink,
}: FooterProps) {
  const year = new Date().getFullYear();
  // `py-1 -my-1`: WCAG 2.2 AA (2.5.8) wants at least a 24px tap target: at
  // `text-sm` (14px / 20px line height) the link's own box was 20px tall,
  // padding-only per the design ruling against bumping font size for a hit
  // area. The negative margin cancels the padding's effect on the row's own
  // height, so the invisible hit area grows without the desktop footer's
  // spacing changing at all.
  const lc =
    'inline-flex items-center py-1 -my-1 hover:text-gray-900 dark:hover:text-white transition-colors';

  const makeLink = (
    href: string,
    children: ReactNode,
    className?: string,
    external?: boolean,
  ) => {
    const isExternal = external || href.startsWith('http');
    if (renderLink && !isExternal) return renderLink(href, children, className);
    return (
      <a
        href={isExternal ? href : `${baseUrl}${href}`}
        className={className}
        {...(isExternal
          ? { target: '_blank', rel: 'noopener noreferrer' }
          : {})}
      >
        {children}
      </a>
    );
  };

  return (
    <footer className="py-6 border-t border-gray-200 dark:border-white/5 bg-white/50 dark:bg-transparent backdrop-blur-sm">
      <div className="max-w-7xl mx-auto px-6 lg:px-12">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col lg:flex-row items-center justify-between gap-4">
            <span className="text-sm text-gray-400 dark:text-white/30">
              {copyright ?? `© ${year} Flowstarter`}
            </span>
            <nav className="flex items-center gap-3 text-sm text-gray-400 dark:text-white/30 flex-wrap justify-center">
              {links.map((link, i) => (
                <span key={link.href} className="flex items-center gap-3">
                  {i > 0 && <Dot />}
                  {makeLink(link.href, link.label, lc, link.external)}
                </span>
              ))}
            </nav>
            <div className="flex items-center gap-3">
              <a
                href="https://twitter.com/flowstarter"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Follow Flowstarter on X (Twitter)"
                className="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/5 flex items-center justify-center hover:bg-[var(--purple)]/10 transition-colors group"
              >
                <svg
                  className="w-4 h-4 text-gray-400 group-hover:text-[var(--purple)] transition-colors"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M8.29 20.251c7.547 0 11.675-6.253 11.675-11.675 0-.178 0-.355-.012-.53A8.348 8.348 0 0022 5.92a8.19 8.19 0 01-2.357.646 4.118 4.118 0 001.804-2.27 8.224 8.224 0 01-2.605.996 4.107 4.107 0 00-6.993 3.743 11.65 11.65 0 01-8.457-4.287 4.106 4.106 0 001.27 5.477A4.072 4.072 0 012.8 9.713v.052a4.105 4.105 0 003.292 4.022 4.095 4.095 0 01-1.853.07 4.108 4.108 0 003.834 2.85A8.233 8.233 0 012 18.407a11.616 11.616 0 006.29 1.84" />
                </svg>
              </a>
              <a
                href="https://linkedin.com/company/flowstarter"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Follow Flowstarter on LinkedIn"
                className="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/5 flex items-center justify-center hover:bg-[var(--purple)]/10 transition-colors group"
              >
                <svg
                  className="w-4 h-4 text-gray-400 group-hover:text-[var(--purple)] transition-colors"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                </svg>
              </a>
              {showClientLogin && (
                <>
                  <span className="w-px h-5 bg-gray-200 dark:bg-white/10 mx-1" />
                  {makeLink(
                    '/login',
                    clientLoginLabel,
                    'text-sm text-gray-400 dark:text-white/30 hover:text-[var(--purple)] transition-colors font-medium',
                  )}
                </>
              )}
            </div>
          </div>
          <div className="flex justify-center">
            <p className="text-xs text-gray-400 dark:text-white/20 flex items-center gap-1.5">
              {builtWithLabel}
              <svg className="w-3.5 h-3.5" viewBox="0 0 20 20">
                <defs>
                  <linearGradient
                    id="footerHeartGrad"
                    x1="0%"
                    y1="0%"
                    x2="100%"
                    y2="100%"
                  >
                    <stop offset="0%" stopColor="var(--purple, #7c3aed)" />
                    <stop offset="100%" stopColor="#ef4444" />
                  </linearGradient>
                </defs>
                <path
                  fill="url(#footerHeartGrad)"
                  fillRule="evenodd"
                  d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z"
                  clipRule="evenodd"
                />
              </svg>
              {byTeamLabel}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
