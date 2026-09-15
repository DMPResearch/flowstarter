import {
  LegalDraftNotice,
  MarketingShell,
  PageHero,
  ProseSection,
} from '@/components/marketing';
import { tServer } from '@/lib/i18n-server';
import {
  analyticsDisclosure,
  CONSENT_STORAGE_NOTE,
  COOKIE_INVENTORY,
} from '@/lib/legal/cookies';
import {
  legalDraftNoticeVisible,
  readOperatorIdentity,
} from '@/lib/legal/company';

export const metadata = {
  title: 'Cookie Policy',
  description:
    'What cookies Flowstarter uses, why we use them, and how to control them.',
};

const LAST_UPDATED = 'September 14, 2026';

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
  // The table is generated from src/lib/legal/cookies.ts, which is checked
  // against what the source actually writes. The hand-written version listed
  // NEXT_LOCALE, which nothing sets; listed flowstarter_cookie_consent as a
  // cookie when it lives in localStorage, and told readers to clear it from
  // their cookie settings, which would have done nothing; and omitted
  // fs_country, the one cookie our own code sets.
  const analytics = analyticsDisclosure();
  const identity = readOperatorIdentity();

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
          {legalDraftNoticeVisible(identity) && <LegalDraftNotice />}

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
              function. These keep you signed in. They are set whether or not
              you accept the cookie banner.
            </li>
            <li>
              <strong>Functional</strong>: small comforts such as your
              light/dark theme preference, the country we infer so prices read
              correctly, and the language you read the site in (your own choice
              from the switcher, or our best guess from your browser). Optional;
              if you decline, the site falls back to system defaults.
            </li>
            <li>
              <strong>Analytics</strong>: {analytics.statement}
            </li>
            <li>
              <strong>Advertising</strong>: we do not use advertising cookies of
              any kind.
            </li>
          </ul>

          <h2>3. The full list</h2>
          <p>
            The table below is every cookie served by this site and our
            authenticated app, including the ones our sign-in provider sets on
            our behalf.
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
                  {COOKIE_INVENTORY.map((row, i) => {
                    const last = i === COOKIE_INVENTORY.length - 1;
                    const cell = last
                      ? { ...cellStyle, borderBottom: 'none' }
                      : cellStyle;
                    return (
                      <tr key={row.name}>
                        <td
                          style={{
                            ...cell,
                            fontFamily: 'var(--ls-mono)',
                            fontSize: '0.82rem',
                            color: 'var(--ls-ink)',
                          }}
                        >
                          {row.name}
                        </td>
                        <td style={cell}>{row.purpose}</td>
                        <td style={{ ...cell, color: 'var(--ls-ink)' }}>
                          {row.category}
                        </td>
                        <td
                          style={{
                            ...cell,
                            fontFamily: 'var(--ls-mono)',
                            fontSize: '0.82rem',
                            color: 'var(--ls-ink-faint)',
                          }}
                        >
                          {row.duration}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <h2>4. How to control your cookies</h2>
          <p>
            The banner at the bottom of the page lets you accept or decline
            non-essential cookies on your first visit. {CONSENT_STORAGE_NOTE}
          </p>
          <p>You can also manage cookies directly in your browser:</p>
          <ul>
            <li>
              <strong>Chrome</strong>: Settings, then Privacy and security, then
              Cookies and other site data.
            </li>
            <li>
              <strong>Firefox</strong>: Settings, then Privacy &amp; Security,
              then Cookies and Site Data.
            </li>
            <li>
              <strong>Safari</strong>: Settings, then Privacy, then Manage
              Website Data.
            </li>
            <li>
              <strong>Edge</strong>: Settings, then Cookies and site
              permissions, then Manage and delete cookies and site data.
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
              Questions about cookies? Ask on the{' '}
              <a href="/contact">contact page</a> or read the full{' '}
              <a href="/privacy">privacy policy</a>.
            </p>
          </div>
        </ProseSection>
      </main>
    </MarketingShell>
  );
}
