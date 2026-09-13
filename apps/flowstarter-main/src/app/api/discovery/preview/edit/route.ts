/**
 * POST /api/discovery/preview/edit
 *
 * The playable demo editor. Takes the current DemoSite JSON + a plain-English
 * instruction, asks the LLM to return the same JSON shape with only allowed
 * mutations (copy, accent hex, section order/visibility), and re-serves it.
 *
 * This is the constrained-editor pattern wired locally — exactly how it will
 * run against the real per-prospect editor sandbox later, just in-process for
 * now. The 20-edit cap is enforced server-side against demo_edit_counters so
 * a refresh / devtools can't reset it.
 *
 * Fails soft: on any LLM/DB problem it returns the unchanged site with an
 * error flag so the prospect's demo never breaks.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isOpenRouterConfigured } from '@/lib/ai/client';
import { callLlm } from '@/lib/ai/llm';
import { readJsonCapped } from '@/lib/net/ingress';
import {
  MAX_DEMO_EDITS,
  isDemoSite,
} from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';

const EditSchema = z.object({
  demoId: z.string().uuid().nullish(),
  instruction: z.string().min(1).max(400),
  site: z.record(z.unknown()),
});

const RATE_LIMIT = 25;
const RATE_WINDOW_MS = 60_000;
const rl = new Map<string, { count: number; resetAt: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const e = rl.get(ip);
  if (!e || now > e.resetAt) {
    rl.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  e.count++;
  return e.count > RATE_LIMIT;
}

function store() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

const SYSTEM = `You edit a website's content model. You are given a JSON object and a plain-English instruction from the site owner.

RULES:
- Return ONLY the updated JSON object. No markdown fences, no commentary.
- Keep EXACTLY the same keys and shape. Do not add or remove top-level keys.
- You MAY change: any text/copy, "accent" (must be a #rrggbb hex), "order" (reordering of the section ids), "hidden" (subset of section ids to hide), nav labels, number of valueProps/services items (keep 2-6).
- You MUST NOT change "tone". Keep section ids from this set only: hero, valueProps, services, about, testimonial, cta.
- Keep copy concise and professional. Honor the instruction; if it's out of scope, make the closest reasonable on-brand change.`;

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';
  if (limited(ip)) {
    return NextResponse.json({ error: 'Too many edits' }, { status: 429 });
  }

  // Capped as it streams rather than buffered and measured afterwards: an
  // anonymous body arrives in whatever size the sender chooses, and a chunked
  // one advertises no size at all. Codex F07.
  const read = await readJsonCapped(request);
  if (read.status === 'too_large') {
    return NextResponse.json(
      { error: 'That request is too large.' },
      { status: 413 }
    );
  }
  if (read.status === 'invalid') {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const body: unknown = read.value;
  const parsed = EditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid payload' },
      { status: 400 }
    );
  }
  const { demoId, instruction, site } = parsed.data;

  // Server-side cap. No counter row (Supabase unset / older demo) → allow,
  // the client mirror still soft-caps.
  const sb = store();
  let editsUsed = 0;
  if (sb && demoId) {
    try {
      const { data } = await sb
        .from('demo_edit_counters')
        .select('edits_used')
        .eq('demo_id', demoId)
        .maybeSingle();
      editsUsed = (data as { edits_used: number } | null)?.edits_used ?? 0;
    } catch {
      // treat as 0 — fail open
    }
    if (editsUsed >= MAX_DEMO_EDITS) {
      return NextResponse.json({
        limitReached: true,
        editsUsed,
        editsLeft: 0,
        site,
      });
    }
  }

  if (!isOpenRouterConfigured()) {
    return NextResponse.json({
      site,
      editsUsed,
      editsLeft: Math.max(0, MAX_DEMO_EDITS - editsUsed),
      error: 'editor-unavailable',
    });
  }

  try {
    // Anonymous funnel traffic: no workspace yet, so the ledger row carries a
    // null workspace_id. `funnel` also books the spend against the monthly €
    // kill-switch, which this route previously never reported.
    const { text } = await callLlm({
      action: 'preview_edit',
      workspaceId: null,
      system: SYSTEM,
      prompt: `INSTRUCTION:\n${instruction}\n\nCURRENT SITE JSON:\n${JSON.stringify(
        site
      )}`,
      temperature: 0.3,
      funnel: {
        kind: 'edit',
        demoId: demoId ?? null,
        ip: ip === 'unknown' ? null : ip,
      },
    });
    const json = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    const next = JSON.parse(json);
    if (!isDemoSite(next)) throw new Error('model returned wrong shape');

    if (sb && demoId) {
      try {
        await sb
          .from('demo_edit_counters')
          .update({
            edits_used: editsUsed + 1,
            updated_at: new Date().toISOString(),
          })
          .eq('demo_id', demoId);
      } catch (e) {
        console.error('[preview/edit] counter bump failed', e);
      }
    }

    const used = editsUsed + 1;
    return NextResponse.json({
      site: next,
      editsUsed: used,
      editsLeft: Math.max(0, MAX_DEMO_EDITS - used),
    });
  } catch (err) {
    console.error('[preview/edit] failed', err);
    // Fail soft — return the unchanged site so the demo never breaks.
    return NextResponse.json({
      site,
      editsUsed,
      editsLeft: Math.max(0, MAX_DEMO_EDITS - editsUsed),
      error: 'edit-failed',
    });
  }
}
