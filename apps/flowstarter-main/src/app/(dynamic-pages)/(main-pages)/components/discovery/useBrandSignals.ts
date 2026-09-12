'use client';

/**
 * Asks the server for the visitor's colours and voice, once, when there is
 * something to ask about.
 *
 * The trigger is a rule, not a timer and not a render: the moment the intake
 * holds at least one profile link AND the visitor's own words about what they
 * offer, the derivation is worth running. Both halves matter. Links alone give
 * a palette and a tone with nothing to phrase it from; words alone give a tone
 * and a palette from tone chips. Waiting for both means the strip fills in once
 * with a complete answer instead of twice with a worse one first.
 *
 * It runs at most once per distinct set of inputs, which is what the signature
 * is for. A visitor who edits their links gets a fresh reading; one who answers
 * six more questions does not get six more outbound requests.
 *
 * Nothing here decides anything about the result. The palette, the tone, the
 * fallbacks and the question of whether to offer the picture upload are all
 * settled server-side, and this hook only carries them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  DerivedPalette,
  DerivedTone,
  DiscoveryData,
  FetchedProfilePicture,
} from './discovery.logic';

export interface BrandSignalsState {
  loading: boolean;
  palette?: DerivedPalette;
  tone?: DerivedTone;
  unavailable: Array<{ network: string; reason: string }>;
  offerPictureUpload: boolean;
  pictureUploaded: boolean;
  /** A picture read off one of their public pages, pending a rights answer. */
  picture?: FetchedProfilePicture;
}

const EMPTY: BrandSignalsState = {
  loading: false,
  unavailable: [],
  offerPictureUpload: false,
  pictureUploaded: false,
};

/** The inputs the derivation actually depends on, as one comparable string. */
export function brandSignature(data: DiscoveryData): string {
  return [
    data.instagramUrl ?? '',
    data.linkedinUrl ?? '',
    data.websiteUrl ?? '',
    (data.description ?? '').trim(),
    (data.brandTone ?? '').trim(),
  ].join('|');
}

/**
 * True when there is enough to derive from.
 *
 * A link is the palette's only source and the visitor's own sentence is the
 * tone's, so one of each. The sentence is `description`, which is the third of
 * the four quick questions: `offer` is asked on the dashboard after the
 * deposit and is empty at this point in the funnel, so keying on it would mean
 * the strip never appeared for anybody.
 */
export function readyToDerive(data: DiscoveryData): boolean {
  const hasLink = Boolean(
    data.instagramUrl || data.linkedinUrl || data.websiteUrl
  );
  const hasWords = (data.description ?? '').trim().length >= 10;
  return hasLink && hasWords;
}

export interface UseBrandSignalsOptions {
  /** Injected in tests. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Set once generation has started, so an upload can be folded in. */
  previewId?: string;
  /** Turns the whole thing off, for the scripted kill-switch path. */
  enabled?: boolean;
}

export function useBrandSignals(
  data: DiscoveryData,
  options: UseBrandSignalsOptions = {}
): BrandSignalsState & { uploadPicture: (file: File) => Promise<void> } {
  const [state, setState] = useState<BrandSignalsState>(EMPTY);
  // The signatures already asked about, so an answer to an unrelated question
  // does not send the same request again.
  const asked = useRef<Set<string>>(new Set());
  const { enabled = true, previewId } = options;
  const fetchImpl = options.fetchImpl;

  const derive = useCallback(
    async (signature: string, body: Record<string, unknown>) => {
      const doFetch = fetchImpl ?? fetch;
      setState((previous) => ({ ...previous, loading: true }));
      try {
        const response = await doFetch('/api/discovery/brand-signals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`status ${response.status}`);
        const json = (await response.json()) as {
          palette?: DerivedPalette;
          tone?: DerivedTone;
          unavailable?: Array<{ network: string; reason: string }>;
          offerPictureUpload?: boolean;
          picture?: FetchedProfilePicture | null;
        };
        setState((previous) => ({
          loading: false,
          palette: json.palette,
          tone: json.tone,
          unavailable: json.unavailable ?? [],
          offerPictureUpload: Boolean(json.offerPictureUpload),
          pictureUploaded: previous.pictureUploaded,
          picture: json.picture ?? undefined,
        }));
      } catch {
        // A brand reading that did not happen is a strip that does not appear.
        // The visitor is mid-intake and has nothing to do about it, so there
        // is nothing worth telling them; the signature stays marked so we do
        // not retry on every keystroke.
        setState((previous) => ({ ...previous, loading: false }));
      }
      void signature;
    },
    [fetchImpl]
  );

  useEffect(() => {
    if (!enabled) return;
    if (!readyToDerive(data)) return;
    const signature = brandSignature(data);
    if (asked.current.has(signature)) return;
    asked.current.add(signature);
    void derive(signature, {
      instagramUrl: data.instagramUrl ?? '',
      linkedinUrl: data.linkedinUrl ?? '',
      websiteUrl: data.websiteUrl ?? '',
      brandTone: data.brandTone ?? '',
      // Empty before the deposit and filled on the dashboard afterwards, so a
      // brand reading re-run from the Brief has more to go on than this one.
      offer: data.offer ?? '',
      description: data.description ?? '',
      ...(previewId ? { previewId } : {}),
    });
  }, [data, derive, enabled, previewId]);

  const uploadPicture = useCallback(
    async (file: File) => {
      if (!previewId) return;
      const doFetch = fetchImpl ?? fetch;
      const form = new FormData();
      form.append('file', file);
      form.append('previewId', previewId);
      form.append('kind', 'logo');
      form.append('rightsConfirmed', 'true');
      try {
        const response = await doFetch('/api/discovery/brand-signals/picture', {
          method: 'POST',
          body: form,
        });
        if (!response.ok) return;
        setState((previous) => ({ ...previous, pictureUploaded: true }));
        // The picture changes the palette, so the derivation is worth
        // re-running. A new signature, because the inputs really did change.
        const signature = `${brandSignature(data)}|picture`;
        if (asked.current.has(signature)) return;
        asked.current.add(signature);
        await derive(signature, {
          instagramUrl: data.instagramUrl ?? '',
          linkedinUrl: data.linkedinUrl ?? '',
          websiteUrl: data.websiteUrl ?? '',
          brandTone: data.brandTone ?? '',
          offer: data.offer ?? '',
          description: data.description ?? '',
          previewId,
        });
      } catch {
        // Same reasoning as above: nothing the visitor can act on.
      }
    },
    [data, derive, fetchImpl, previewId]
  );

  return { ...state, uploadPicture };
}
