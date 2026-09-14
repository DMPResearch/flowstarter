/**
 * POST /api/discovery/preview
 *
 * Generates a real first-pass site preview from the discovery wizard answers
 * using the same system-prompt LLM pipeline the team uses (generateSiteCopy →
 * OpenRouter / Claude). This is the "wire it locally" path: real generation,
 * no Docker/Hetzner sandbox yet. The wizard renders the result into the
 * preview frame; the deterministic mock stays as the fail-open fallback.
 *
 * Public (under the /api/discovery allowlist), rate-limited, fails open:
 * if OpenRouter is unconfigured or generation errors, returns { skip:true }
 * so the wizard shows the static mock instead of dead-ending.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isOpenRouterConfigured } from '@/lib/ai/client';
import {
  generateSiteCopy,
  SITE_COPY_MODEL,
  type SiteCopyInput,
  type SiteCopyUsage,
} from '@/lib/ai/site-copy';
import { funnelBudgetState, recordGenerationCost } from '@/lib/ai/funnel-cost';
import { readJsonCapped } from '@/lib/net/ingress';
import { buildDemoSite } from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';
import { clientIp } from '@/lib/request-ip';

/** Service client — demo_edit_counters/discovery_leads aren't in gen types. */
function store() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

const PreviewSchema = z.object({
  businessName: z.string().max(200).optional().default(''),
  fullName: z.string().max(200).optional().default(''),
  description: z.string().min(1).max(5000),
  industry: z.string().max(200).optional().default(''),
  targetAudience: z.string().max(500).optional().default(''),
  // Free-form now (chips + freetext, comma-joined) — see discovery.logic.
  goal: z.string().max(400).optional().default(''),
  brandTone: z.string().max(400).optional().default(''),
});

const RATE_LIMIT = 4;
const RATE_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

/** Free-form wizard goal → site-copy goal bucket. */
function mapGoal(g: string): SiteCopyInput['goal'] {
  const s = g.toLowerCase();
  if (/sell|shop|sales|product|store|buy/.test(s)) return 'sales';
  if (/book|appointment|reserv|session/.test(s)) return 'bookings';
  return 'leads';
}

/** Free-form wizard tone → site-copy tone bucket. */
function mapTone(t: string): SiteCopyInput['brandTone'] {
  const s = t.toLowerCase();
  if (/bold|vibrant|energetic|playful|colou?rful/.test(s)) return 'bold';
  if (/warm|friendly|approachable|calm|natural|earthy/.test(s))
    return 'friendly';
  return 'professional';
}

// Prewarm path: the mockup generator is the funnel's first preview call, so a
// cold start here is felt directly. This route's AI/Supabase deps are
// top-level imports loaded at module init, so any invocation warms the
// container — a no-op GET keeps it warm without running a generation (no LLM /
// DB writes). Hit by the scheduled prewarm function.
export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get('warm') === '1') {
    return NextResponse.json({ warmed: true }, { status: 200 });
  }
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}

export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: 'Too many attempts' }, { status: 429 });
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

  const parsed = PreviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid payload' },
      { status: 400 }
    );
  }
  const d = parsed.data;

  // Fail open — wizard falls back to the deterministic mock.
  if (!isOpenRouterConfigured()) {
    return NextResponse.json({ skip: true });
  }

  const businessName = (d.businessName || d.fullName || '').trim();
  if (!businessName) {
    return NextResponse.json({ skip: true });
  }

  // Funnel budget kill-switch: over the monthly cap → fail open to the
  // deterministic template demo (the wizard handles {skip:true}).
  const budget = await funnelBudgetState();
  if (budget.state === 'blocked') {
    return NextResponse.json({ skip: true });
  }

  try {
    let usage: SiteCopyUsage | undefined;
    const copy = await generateSiteCopy(
      {
        businessName,
        description: d.description,
        industry: d.industry || undefined,
        targetAudience: d.targetAudience || undefined,
        goal: mapGoal(d.goal),
        brandTone: mapTone(d.brandTone),
      },
      (u) => {
        usage = u;
      }
    );

    const site = buildDemoSite(
      {
        businessName: d.businessName,
        fullName: d.fullName,
        industry: d.industry,
        targetAudience: d.targetAudience,
        brandTone: d.brandTone || '',
      },
      copy
    );

    // Create the server-side edit counter (caps the playable editor).
    let demoId: string | null = null;
    const sb = store();
    if (sb) {
      try {
        const { data, error } = await sb
          .from('demo_edit_counters')
          .insert({ edits_used: 0 })
          .select('demo_id')
          .single();
        if (error) throw error;
        demoId = (data as { demo_id: string } | null)?.demo_id ?? null;
      } catch (e) {
        console.error('[discovery/preview] counter create failed', e);
      }
    }

    await recordGenerationCost({
      kind: 'preview',
      model: SITE_COPY_MODEL,
      usage,
      demoId,
      ip: ip === 'unknown' ? null : ip,
    });

    return NextResponse.json({ site, demoId });
  } catch (err) {
    console.error('[discovery/preview] generation failed', err);
    return NextResponse.json({ skip: true });
  }
}
