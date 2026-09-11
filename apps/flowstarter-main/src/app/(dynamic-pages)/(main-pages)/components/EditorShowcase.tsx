'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useMockEditor } from './useMockEditor';
import { MockEditorPreview } from './MockEditorPreview';
import { SectionEyebrow } from './SectionEyebrow';

export function EditorShowcase() {
  const { t: tStrict } = useI18n();
  const t = tStrict as (key: string) => string;
  const editor = useMockEditor();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [mobileEditorExpanded, setMobileEditorExpanded] = useState(false);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    // Latch-once: expand when the section first comes into view, then stop
    // observing. The mobile-expanded class changes the section's height, which
    // would change the intersection ratio and re-fire the observer — a
    // feedback loop that flickers fast on mobile. Disconnecting after the
    // first trigger breaks the loop while keeping the intended behavior
    // (compact before you reach it, expanded once you're there).
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMobileEditorExpanded(true);
          observer.disconnect();
        }
      },
      {
        root: null,
        threshold: 0.35,
        rootMargin: '-10% 0px -25% 0px',
      }
    );

    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      id="editor-showcase"
      className="ls-scope ls-section ls-section--pad ls-fade-top"
    >
      <div className="ls-mesh" aria-hidden />
      <div className="ls-orb ls-orb--violet ls-orb--tl" aria-hidden />
      <div className="ls-grain" aria-hidden />

      <div className="ls-container">
        <div className="text-center max-w-3xl mx-auto">
          <SectionEyebrow
            index="02"
            label={t('landing.editorShowcase.eyebrow')}
          />
          <h2 className="ls-display mt-7" style={{ textWrap: 'balance' }}>
            <span className="line">
              {t('landing.editorShowcase.headlinePrefix')}
            </span>
            <span className="line flourish mt-2">
              {t('landing.editorShowcase.headlineFlourish')}
            </span>
          </h2>
          <p className="ls-body ls-body--lead mt-7 mx-auto">
            {t('landing.editorShowcase.sub')}
          </p>
        </div>

        <div className="ls-editor-stage mx-auto mt-16 max-w-6xl">
          {/* Ambient halo */}
          <div className="ls-editor-halo" aria-hidden />

          {/* Register marks — blueprint corners */}
          <span className="ls-editor-mark ls-editor-mark--tl" aria-hidden />
          <span className="ls-editor-mark ls-editor-mark--tr" aria-hidden />
          <span className="ls-editor-mark ls-editor-mark--bl" aria-hidden />
          <span className="ls-editor-mark ls-editor-mark--br" aria-hidden />

          <div
            className="ls-dashboard-mock"
            role="img"
            aria-label={t('landing.editorShowcase.dashboard.label')}
          >
            <div className="ls-dashboard-mock-hdr">
              <span className="ls-dashboard-mock-label">
                {t('landing.editorShowcase.dashboard.label')}
              </span>
              <span className="ls-dashboard-mock-status">
                <i aria-hidden />
                {t('landing.editorShowcase.dashboard.statusLive')}
              </span>
            </div>
            <div className="ls-dashboard-mock-body">
              <div className="ls-dashboard-mock-project">
                <strong>{t('landing.editorShowcase.dashboard.project')}</strong>
                <div className="ls-dashboard-mock-phase">
                  <span>
                    {t('landing.editorShowcase.dashboard.phaseLabel')}
                  </span>
                  <b>{t('landing.editorShowcase.dashboard.phaseValue')}</b>
                </div>
              </div>
              <div className="ls-dashboard-mock-actions">
                <span className="ls-dashboard-mock-cta">
                  {t('landing.editorShowcase.dashboard.openEditor')}
                </span>
                <span className="ls-dashboard-mock-link">
                  {t('landing.editorShowcase.dashboard.viewSite')}
                </span>
              </div>
            </div>
            <p className="ls-dashboard-mock-hint">
              {t('landing.editorShowcase.dashboard.hint')}
            </p>
          </div>

          <div
            className={`ls-editor-surface ${
              mobileEditorExpanded
                ? 'ls-editor-surface--mobile-expanded'
                : 'ls-editor-surface--mobile-fixed'
            }`}
          >
            <MockEditorPreview {...editor} />
          </div>
        </div>
      </div>
    </section>
  );
}
