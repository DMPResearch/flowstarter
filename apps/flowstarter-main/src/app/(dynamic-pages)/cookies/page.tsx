import {
  LegalDraftNotice,
  MarketingShell,
  PageHero,
  ProseSection,
} from '@/components/marketing';
import { tServer } from '@/lib/i18n-server';

export const metadata = {
  title: 'Cookie Policy',
  description:
    'What cookies Flowstarter uses, why we use them, and how to control them.',
};

const LAST_UPDATED = 'May 2026';

type CookieRow = {
  name: string;
  purpose: string;
  type: 'Strictly necessary' | 'Functional' | 'Analytics';
  duration: string;
};

const COOKIE_TABLE: CookieRow[] = [
  {
    name: '__session',
    purpose: 'Keeps you signed in. Set by Clerk after a successful sign-in.',
    type: 'Strictly necessary',
    duration: 'Session (up to 7 days)',
  },
  {
    name: '__client_uat',
    purpose:
      'Used by Clerk to detect that a user has previously authenticated.',
    type: 'Strictly necessary',
    duration: '1 year',
  },
  {
    name: 'flowstarter_theme',
    purpose: 'Remembers your light / dark theme preference.',
    type: 'Functional',
    duration: '1 year',
  },
  {
    name: 'flowstarter_cookie_consent',
    purpose:
      'Stores your cookie-banner choice so we do not ask again on every visit.',
    type: 'Strictly necessary',
    duration: '1 year',
  },
  {
    name: 'NEXT_LOCALE',
    purpose:
      'Remembers your preferred language so the next visit loads in the same locale.',
    type: 'Functional',
    duration: '1 year',
  },
];

const cellStyle = {
  padding: '0.7rem 0.85rem',
  borderBottom: '1px solid var(--ls-rule)',
  fontFamily: 'var(--ls-sans)',
  fontSize: '0.9rem',
  lineHeight: 1.5,
  color: 'var(--ls-ink-dim)',
  verticalAlign: 'top' as const,
};

const headerCellStyle = {
  ...cellStyle,
  fontFamily: 'var(--ls-mono)',
  fontSize: '10.5px',
  letterSpacing: '0.18em',
  textTransform: 'uppercase' as const,
  color: 'var(--ls-ink-faint)',
  background: 'transparent',
  borderBottom: '1px solid var(--ls-rule-strong)',
  fontWeight: 500,
  textAlign: 'left' as const,
};

export default function CookiesPage() {
  const t = tServer as (key: string) => string;
  return (
    <MarketingShell>
      <main id="main-content" className="flex-1">
        <PageHero
          eyebrow={t('cookies.heroEyebrow')}
          headlinePrefix={t('cookies.heroHeadlinePrefix')}
          headlineFlourish={t('cookies.heroHeadlineFlourish')}
          sub={t('cookies.heroSub')}
          meta={
            <span className="ls-page-meta">
              <span>{t('cookies.lastUpdatedLabel')}</span>
              <span className="dot" aria-hidden="true" />
              <span>{LAST_UPDATED}</span>
            </span>
          }
        />

        <ProseSection>
          <LegalDraftNotice />

          <h2>1. What is a cookie?</h2>
          <p>
            A cookie is a small text file that a website stores in your browser.
            It can hold a session token, a preference, or a counter. Cookies
            cannot run code or read other files on your device.
          </p>

          <h2>2. The categories we use</h2>
          <ul>
            <li>
              <strong>Strictly necessary</strong>: required for the site to
              function. These keep you signed in, remember your consent choice,
              and protect against cross-site request forgery. They are set
              whether or not you accept the cookie banner.
            </li>
            <li>
              <strong>Functional</strong>: small comforts such as your
              light/dark theme preference and your chosen language. Optional; if
              you decline, the site falls back to system defaults.
            </li>
            <li>
              <strong>Analytics</strong>: we currently use Plausible, a
              privacy-friendly analytics tool that does <em>not</em> set
              cookies. We do not run Google Analytics, Facebook Pixel, or any
              cross-site advertising tracker.
            </li>
            <li>
              <strong>Advertising</strong>: we do not use advertising cookies of
              any kind.
            </li>
          </ul>

          <h2>3. The full list</h2>
          <p>
            The table below is the complete inventory of cookies served by
            flowstarter.net and our authenticated app.
          </p>

          <div
            style={{
              marginTop: '1.2rem',
              border: '1px solid var(--ls-rule)',
              borderRadius: '14px',
              overflow: 'hidden',
              background: 'var(--ls-glass-bg)',
            }}
          >
            <div style={{ overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontFamily: 'var(--ls-sans)',
                }}
              >
                <thead>
                  <tr>
                    <th style={headerCellStyle}>Name</th>
                    <th style={headerCellStyle}>Purpose</th>
                    <th style={headerCellStyle}>Category</th>
                    <th style={headerCellStyle}>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {COOKIE_TABLE.map((row, i) => (
                    <tr key={row.name}>
                      <td
                        style={{
                          ...cellStyle,
                          fontFamily: 'var(--ls-mono)',
                          fontSize: '0.82rem',
                          color: 'var(--ls-ink)',
                          borderBottom:
                            i === COOKIE_TABLE.length - 1
                              ? 'none'
                              : cellStyle.borderBottom,
                        }}
                      >
                        {row.name}
                      </td>
                      <td
                        style={{
                          ...cellStyle,
                          borderBottom:
                            i === COOKIE_TABLE.length - 1
                              ? 'none'
                              : cellStyle.borderBottom,
                        }}
                      >
                        {row.purpose}
                      </td>
                      <td
                        style={{
                          ...cellStyle,
                          color: 'var(--ls-ink)',
                          borderBottom:
                            i === COOKIE_TABLE.length - 1
                              ? 'none'
                              : cellStyle.borderBottom,
                        }}
                      >
                        {row.type}
                      </td>
                      <td
                        style={{
                          ...cellStyle,
                          fontFamily: 'var(--ls-mono)',
                          fontSize: '0.82rem',
                          color: 'var(--ls-ink-faint)',
                          borderBottom:
                            i === COOKIE_TABLE.length - 1
                              ? 'none'
                              : cellStyle.borderBottom,
                        }}
                      >
                        {row.duration}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <h2>4. How to control your cookies</h2>
          <p>
            The cookie banner at the bottom of the page lets you accept or
            decline non-essential cookies on your first visit. You can change
            your choice at any time by clearing the
            <code> flowstarter_cookie_consent </code> cookie in your browser
            settings. The banner will reappear on the next visit.
          </p>
          <p>You can also manage cookies directly in your browser:</p>
          <ul>
            <li>
              <strong>Chrome</strong>: Settings → Privacy and security → Cookies
              and other site data.
            </li>
            <li>
              <strong>Firefox</strong>: Settings → Privacy &amp; Security →
              Cookies and Site Data.
            </li>
            <li>
              <strong>Safari</strong>: Settings → Privacy → Manage Website Data.
            </li>
            <li>
              <strong>Edge</strong>: Settings → Cookies and site permissions →
              Manage and delete cookies and site data.
            </li>
          </ul>
          <p>
            If you block strictly-necessary cookies, parts of the site (sign-in,
            billing) will not work.
          </p>

          <h2>5. Updates to this policy</h2>
          <p>
            We refresh this page whenever we add or remove a cookie. The
            &ldquo;last updated&rdquo; date at the top always reflects the
            latest revision.
          </p>

          <div className="ls-callout">
            <p>
              Questions about cookies? Write to{' '}
              <a href="mailto:privacy@flowstarter.net">
                privacy@flowstarter.net
              </a>{' '}
              or read the full <a href="/privacy">privacy policy</a>.
            </p>
          </div>
        </ProseSection>
      </main>
    </MarketingShell>
  );
}
