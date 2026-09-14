# Flowstarter: Concierge Pivot Plan
## February 2026 — last revised May 2026

> **⚠️ Superseded for pricing + tier names + billing structure.**
> See `docs/FLOWSTARTER_MASTER_DECISIONS.md` (May 2026) which is the canonical
> source for: subscription tiers (Essential / Pro / Commerce), setup fees
> (Service site / Shopify store / Custom), founding vs standard pricing,
> annual + monthly billing, 4-stage milestone payments, and the Spec-Match
> Guarantee. The strategic narrative + technical architecture sections of
> this doc remain relevant.

---

## Architecture updates (decided 2026-05-06)

The original plan assumed Cloudflare Pages + Daytona-managed sandboxes. After working through the implementation, the architecture has been finalized as follows:

- **Platform split**: `flowstarter-main` (this Next.js app) hosts on **Netlify**. Heavy compute (per-client sandboxes, the editor, deploy/operator services) hosts on **Hetzner**.
- **Per-client sandboxes**: each project runs in its own **Docker container** on a shared Hetzner server. Strong isolation: per-client volumes, user-namespace remapping, private bridge networks, internal-only file-ops agent. Replaces Daytona for client-facing.
- **Editor**: a stripped-down fork of T3 Code, **multitenant**, hosted on Hetzner at `editor.flowstarter.app`. Auth by Clerk (team) or magic-link (client). UI gated by `client_editor_access_level`. Team role auto-grants full access; clients get the level set on their project.
- **Hosting topology**: shared Caddy host on Hetzner reverse-proxies:
  - `editor.flowstarter.app` → editor container
  - `{slug}.preview.flowstarter.app` → that client's dev-server container
  - `{custom-domain}` → that client's production output
- **DNS**: Cloudflare API, called from the Hetzner operator service (not from Netlify functions, to avoid the 10–26s function timeout when provisioning takes 60–120s).
- **Operator service**: a small Bun/Node app on Hetzner that owns Hetzner Cloud API calls + Docker lifecycle + deploy jobs + DNS upserts. flowstarter-main on Netlify enqueues jobs to it via a shared-bearer-authed HTTP API.
- **Client editor evolution**: Phase 1 = chat-only (request a change → escalates to team). Phase 2 = iframe + click-to-edit overlay. Phase 3 = block editor. Phase 4 = full-code unlock (paid upsell, same T3 with hidden chrome shown).
- **Daytona** stays only for the team-internal generation flow until the per-client Docker pipeline replaces it. Removed from client-facing.

Sections of this doc that mention Cloudflare Pages, `pages.dev` URLs, or Daytona-as-client-editor predate this update and are preserved for context.

---

## Pricing (current — superseded by FLOWSTARTER_MASTER_DECISIONS.md)

The build (one-time setup) and the monthly plan are **decoupled**: a client
picks a build package and, separately, a monthly plan sized by editor
capabilities. All setup prices are "from" minimums; final scope is agreed on the
call. Storefront/Commerce is **open to everyone** (no longer coming-soon).

**Build packages (one-time, from):**

| Package | From | Best for |
|---------|------|----------|
| **Starter** | €799 | Coaches, consultants, therapists, freelancers, solo service businesses. |
| **Pro** | €1,199 | Growing service businesses, multi-page sites, extended integrations, Stripe for digital products. |
| **Ecommerce** | €1,499 | A real catalog: custom Astro storefront headless against **Shopify** (physical) or **Lemon Squeezy / Paddle** (digital). Open to everyone. |
| **Custom** | €2,499 | Bespoke web apps / integrations, quoted on the call. |

**Monthly plan (independent of the build):** Starter €49/mo for guided editor
access, Pro €99/mo with manual model selection, Max €249/mo with code
experimentation. The Ecommerce package uses a dedicated store plan:
**€129/mo** with product and collection editing. First month free; change or
cancel anytime.

**Booking the discovery call is free.** A 10%-of-setup booking deposit was
planned here and never wired into the funnel; the route and its constants
were removed on 2026-09-14. Calls are booked on the self-hosted Cal.com
through `/discovery-call`, and the first money in the product is the 20%
build deposit after the preview.

All builds include: domain, professional email, hosting, smart editor,
ongoing support, first month free, 50% setup refund if not happy in 30 days.
Discovery call is **30 minutes**.

**Why a separate Ecommerce package?** A branded headless storefront is real
extra work (provider setup, products, shop pages, cart/checkout, webhooks).
Most service clients don't sell products, so it stays a separate package
rather than bundled into Pro.

**Relaunch** (from €999, audit + rebuild) and **Custom** (from €2,499) are
quoted on the call.

Heavy commerce ops (payment, tax, fulfillment, refunds, inventory) stay at the provider — Flowstarter renders product display + cart UI but **never reimplements checkout**. See `docs/CONCIERGE_COMMERCE_MODEL.md` for provider routing and `docs/PRO_PLAN_DELIVERY.md` for the Pro/Commerce delivery model.

---

## Executive Summary

Flowstarter pivots from a public AI website builder to a **concierge-first managed web presence service**. The founding team (Darius + Dorin) handles initial client setup via discovery calls. The self-service wizard launches later, informed by patterns from 50-100+ concierge clients.

**Core Value Proposition:** Client describes a change in plain language → AI executes it correctly, first try, every time.

**Moat:** Human judgment + AI execution. Cannot be fully automated.

---

## Strategic Principles

1. **LLM Plans, Deterministic System Executes** - AI thinks, orchestrator does. Never AI doing everything end-to-end.
2. **Template-First Architecture** - AI customizes pre-built templates, never generates from scratch. Predictable, reliable, near-zero-bug output.
3. **Expert Systems Over AGI** - Specialized agents coordinated by deterministic routing.
4. **Retention Through Value, Not Lock-In** - Clients own everything: source code, assets, domain. Zero lock-in.

---

## Current State Assessment

### ✅ Already Built & Functional

| Component | Status | Notes |
|-----------|--------|-------|
| Editor + AI Chat | ✅ Complete | WebSocket agent communication, streaming + persistence |
| Message System | ✅ Complete | useMessages hook combining stream + Convex history |
| File Viewer | ✅ Complete | Convex subscriptions |
| Onboarding Wizard (3-Step) | ✅ Complete | **Needs to be hidden** - internal-only tool |
| Orchestrator Core | ✅ Partial | Real-time project state in Convex |
| Storage Provider | ✅ Complete | Convex implementation |
| Message Stream Provider | ✅ Complete | WebSocket to coding agent |
| Data Sync | ✅ Complete | Convex → Supabase on publish boundary |

### ❌ Not Yet Built

| Component | Priority | Target |
|-----------|----------|--------|
| **Customization Engine** | P1 🔴 | May 2026 (pilot client) |
| Publish Pipeline | P2 | Cloudflare Pages Direct Upload |
| Template-First Generation | P2 | AI against known template structures |
| Provisioning Pipeline | P3 | Domain, email, storage automation |
| Landing Page (Concierge) | P3 | New marketing site |
| Client Customization UI | P3 | Post-delivery interface |
| Billing/Subscriptions | P4 | Stripe integration |
| Escalation Tracking | P4 | Human handoff system |
| Commerce Routing | P4 | See `docs/CONCIERGE_COMMERCE_MODEL.md` |

---

## Priority 1: Customization Engine (THE BAR)

**Deadline:** Must work for pilot client in May 2026

**Success Criteria:** Client describes a change in plain language → orchestrator executes correctly, first try, every time.

### Architecture

```
Client Request (plain language via editor chat)
                    │
                    ▼
┌─────────────────────────────────────────┐
│         LLM Planner (Claude Opus)       │
│  • Analyzes request against KNOWN       │
│    template structure                   │
│  • Decomposes into deterministic steps  │
│  • Creates execution plan (JSON)        │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│      Deterministic Orchestrator         │
│  • Validates plan against template      │
│  • Executes steps in sequence           │
│  • Rolls back on failure                │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│          Template Mutators              │
│  • Content updates (text, images)       │
│  • Style changes (colors, fonts)        │
│  • Structure changes (sections, pages)  │
│  • Component swaps                      │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│           Preview + Validate            │
│  • Live preview generation              │
│  • Visual diff                          │
│  • Client approval flow                 │
└─────────────────────────────────────────┘
```

### Full Customization Flow

```
Client Request (plain language via editor chat)
                    │
                    ▼
┌─────────────────────────────────────────┐
│         LLM Planner (Claude Opus)       │
│  • Analyzes request against KNOWN       │
│    template structure                   │
│  • Decomposes into deterministic steps  │
│  • Creates execution plan (JSON)        │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│      Deterministic Orchestrator         │
│  • Validates plan against template      │
│    schema                               │
│  • Routes each step to appropriate      │
│    agent/function                       │
│  • Executes in sequence                 │
│  • Handles errors deterministically     │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│   Specialized AI Agents (cheap models)  │
│  • Kimi K2, Sonnet, etc.               │
│  • Code modification agent              │
│  • Content/copy agent                   │
│  • SEO agent                            │
│  • Design/layout agent                  │
│  • Each works against KNOWN template    │
│    structure, NOT from scratch          │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│     Validation Layer (deterministic)    │
│  • Checks output against template       │
│    schema                               │
│  • Validates HTML/CSS/JS                │
│  • Runs quality checks                  │
│  • Approves or returns to agent with    │
│    specific error                       │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│   Updated Site Rendered in Editor       │
│             Preview                     │
└─────────────────────────────────────────┘
```

### What Needs to Be Built/Adapted

1. **Define Template Structure** - Component names, file patterns, customization points
2. **Adapt Orchestrator** - Work in "customization mode" (not generation-from-scratch)
3. **Plan → Execute → Validate Loop** - Full cycle with error handling
4. **AI-Friendly Base Templates (3-5)** - Clear component names, consistent patterns, predictable file structure

### Standard Customization Requests (Must Work Reliably)

| Request Type | Example |
|--------------|---------|
| Text changes | "Change the headline to 'Welcome Home'" |
| Color/theme updates | "Make it more blue, less orange" |
| Section add/remove/reorder | "Add a testimonials section after services" |
| Image swaps | "Replace hero image with this photo" |
| Layout adjustments | "Make the features 2 columns instead of 3" |
| SEO tweaks | "Update meta description to mention yoga" |
| New page creation | "Add an About page with my bio" |

### Success Criteria

> Take an existing template-based site, describe a change in plain English/Romanian, and the engine applies it correctly without breaking anything. **Repeatedly. Reliably.**

### Customization Engine Components

#### 1. Request Analyzer
```typescript
interface CustomizationRequest {
  raw: string;                    // Client's plain language request
  intent: CustomizationIntent;    // Parsed intent
  scope: 'content' | 'style' | 'structure' | 'component';
  confidence: number;
  clarificationNeeded?: string;
}

type CustomizationIntent = 
  | { type: 'update_text'; target: string; newContent: string }
  | { type: 'change_color'; target: string; color: string }
  | { type: 'swap_image'; target: string; imageUrl: string }
  | { type: 'add_section'; sectionType: string; position: string }
  | { type: 'remove_section'; target: string }
  | { type: 'reorder'; from: string; to: string };
```

#### 2. Template Schema Registry
Each template has a known schema that the AI plans against:

```typescript
interface TemplateSchema {
  id: string;
  name: string;
  sections: SectionSchema[];
  styles: StyleSchema;
  components: ComponentSchema[];
  constraints: TemplateConstraints;
}

interface SectionSchema {
  id: string;
  type: 'hero' | 'features' | 'testimonials' | 'pricing' | 'contact' | 'footer';
  editable: EditableField[];
  variants: string[];
}
```

#### 3. Execution Plan Format
```typescript
interface ExecutionPlan {
  id: string;
  request: CustomizationRequest;
  steps: ExecutionStep[];
  rollbackPlan: RollbackStep[];
  estimatedTime: number;
  riskLevel: 'low' | 'medium' | 'high';
}

interface ExecutionStep {
  id: string;
  action: string;
  target: string;
  params: Record<string, any>;
  validation: ValidationRule[];
  dependsOn?: string[];
}
```

#### 4. Safe Mutation Layer
- All mutations go through validated transformers
- No raw file writes from AI
- Schema-validated output
- Automatic rollback on validation failure

---

## Priority 1B: Internal Site Generation

**Purpose:** Generate initial site from templates during discovery call setup. Used internally only — doesn't need to be perfect, just functional.

### Generation Flow (Internal Use)

```
Discovery Call Notes
         │
         ▼
┌─────────────────────────────────────────┐
│   Team Selects Template                 │
│   • service-professional                │
│   • local-business                      │
│   • creative-portfolio                  │
│   • etc.                                │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│   Team Fills Basic Info                 │
│   • Business name                       │
│   • Industry/niche                      │
│   • Services offered                    │
│   • Contact info                        │
│   • Color preferences                   │
│   • Existing content (if any)           │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│   AI Content Generation                 │
│   • Hero copy                           │
│   • Service descriptions                │
│   • About section                       │
│   • Meta tags / SEO                     │
│   • Fill template slots                 │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│   Template Hydration                    │
│   • Merge content with template         │
│   • Apply color palette                 │
│   • Generate pages                      │
│   • Store in Convex                     │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│   Preview Ready                         │
│   • Team reviews in editor              │
│   • Manual tweaks if needed             │
│   • Then customization engine takes over│
└─────────────────────────────────────────┘
```

### Internal Generation UI (Wizard)

```
┌─────────────────────────────────────────────────────────────────┐
│  NEW PROJECT (Internal)                                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Step 1: Client Info                                            │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Business Name: [_______________]                            ││
│  │ Industry:      [Coaching ▼]                                 ││
│  │ Services:      [Life coaching, career transitions, ...]    ││
│  │ Contact Email: [_______________]                            ││
│  │ Phone:         [_______________]                            ││
│  │ Location:      [_______________] (optional)                 ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Step 2: Template & Style                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Template: [●] Service Pro  [ ] Local Biz  [ ] Portfolio    ││
│  │                                                              ││
│  │ Color Palette: [Warm ▼]  Preview: 🟠🟤⚪                    ││
│  │                                                              ││
│  │ Tone: [Professional ▼]                                      ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Step 3: Content Input (Optional)                               │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Existing website: [_______________]                         ││
│  │ About text:       [_______________]                         ││
│  │ Upload logo:      [Choose File]                             ││
│  │ Upload photos:    [Choose Files]                            ││
│  │                                                              ││
│  │ Discovery call notes:                                        ││
│  │ [                                                           ]││
│  │ [                                                           ]││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│                    [Generate Site →]                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Points

1. **Internal only** — Not client-facing, team uses it
2. **Good enough** — AI generates 80%, team polishes 20%
3. **Fast** — Minutes to generate, not hours
4. **Foundation** — Output feeds into customization engine for refinement

### Generation vs Customization

| Phase | Tool | Quality | Who |
|-------|------|---------|-----|
| **Generation** | Internal wizard | 80% good | Team |
| **Customization** | Engine | 100% reliable | Team + Client |

Generation creates the starting point. Customization makes it perfect.

---

## Priority 2: Hide Onboarding, Keep Internal

### Current State
3-step onboarding wizard is public-facing.

### Target State
Same wizard, but:
- Hidden from public access (env flag or route protection)
- Used internally by founding team during concierge setup
- Team fills it out based on discovery call notes
- Data flows into Convex exactly as before
- No client-facing login required during setup phase

### Implementation
Simple feature flag or auth gate:

```typescript
// Option 1: Environment flag
NEXT_PUBLIC_INTERNAL_ONLY=true

// Option 2: Route protection
// /app/(internal)/wizard/...
// Check for team member auth
```

**Key Point:** The UI, data flow, and Convex persistence stay exactly as-is. Just hide from public.

---

## Priority 3: Publish Pipeline

### Full Flow

```
Convex Project State
         │
         ▼
┌─────────────────────────────────────────┐
│   Generate Static Site Code             │
│   • Template + customizations           │
│   • Asset optimization                  │
│   • HTML/CSS/JS minification            │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│   Cloudflare Pages Direct Upload        │
│   • NO GitHub repos for clients         │
│   • NO leak risk                        │
│   • Each client = 1 CF Pages project    │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│   S3/R2 Snapshot Backup                 │
│   • Store code bundle                   │
│   • Enable rollback without regen       │
│   • Version history                     │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│   Update Supabase Records               │
│   • Deployment status                   │
│   • URL mapping                         │
│   • Version tracking                    │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│   Custom Domain (via Cloudflare API)    │
│   • DNS configuration                   │
│   • SSL auto-provisioned                │
└─────────────────────────────────────────┘
```

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Hosting | Cloudflare Pages Direct Upload | No GitHub repos, no leak risk |
| Backup | S3/R2 snapshots | Enables rollback without regeneration |
| Project model | 1 CF Pages project per client | Clean isolation |
| Domains | Cloudflare API | Automated DNS + SSL |

### Deployment Record (Convex)
```typescript
interface Deployment {
  projectId: Id<"projects">;
  version: number;
  status: 'pending' | 'building' | 'deploying' | 'live' | 'failed';
  cloudflareDeploymentId: string;
  previewUrl: string;
  productionUrl?: string;
  createdAt: number;
  publishedAt?: number;
  filesHash: string;
}
```

---

## Priority 3: Template-First Generation

### Base Templates (Launch with 3-5)

1. **Service Professional** - Coaches, consultants, therapists
2. **Local Business** - Restaurants, salons, shops
3. **Creative Portfolio** - Photographers, designers, artists
4. **SaaS Landing** - Product launches, waitlists
5. **Personal Brand** - Speakers, authors, influencers

### Template Structure

```
templates/
├── service-professional/
│   ├── config.json          # Template metadata + schema
│   ├── content/             # Editable content (markdown)
│   │   ├── hero.md
│   │   ├── services.md
│   │   ├── testimonials.md
│   │   └── contact.md
│   ├── palettes/            # Color schemes
│   │   ├── warm.json
│   │   ├── cool.json
│   │   └── neutral.json
│   ├── src/                 # Astro source
│   │   ├── components/
│   │   ├── layouts/
│   │   └── pages/
│   └── public/              # Static assets
```

### Content Generation Flow

```
Discovery Call Notes
        │
        ▼
┌───────────────────────────┐
│  Business Context Agent   │
│  • Extract key info       │
│  • Generate content map   │
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│  Content Generator        │
│  • Fill template slots    │
│  • Industry-specific tone │
│  • SEO optimization       │
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│  Human Review             │
│  • Quality check          │
│  • Client-specific tweaks │
└───────────────────────────┘
```

---

## Priority 4: Provisioning Pipeline (Manual → Automated)

### Services Per Client

| Service | Provider | API Available | Manual Fallback |
|---------|----------|---------------|-----------------|
| Domain registration | Cloudflare Registrar | ✅ Yes | Dashboard |
| DNS configuration | Cloudflare DNS | ✅ Yes | Dashboard |
| Professional email (2 mailboxes) | Zoho Mail | ✅ REST API | Zoho admin |
| Cloud storage (5GB) | Cloudflare R2 | ✅ Yes | Manual bucket |
| SSL certificate | Cloudflare | ✅ Automatic | N/A |

### Automation Strategy

**Launch:** Manual (30 min/client) - acceptable for first 10-20 clients

**Automation Order:** Start manual, automate most-repetitive tasks first

| Phase | Automate | Time Saved |
|-------|----------|------------|
| Phase 1 | DNS + SSL (Cloudflare API) | 10 min |
| Phase 2 | Email setup (Zoho API) | 10 min |
| Phase 3 | Storage (R2 API) | 5 min |
| Phase 4 | Domain purchase (Registrar API) | 5 min |

**Full automation = Year 1 goal, NOT a launch requirement**

### Provisioning Flow

```
Client Onboarded
       │
       ▼
┌──────────────────────────────┐
│  1. Domain Configuration     │
│  • DNS setup (Cloudflare)    │
│  • SSL provisioning (auto)   │
│  • Redirect rules            │
└──────────────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│  2. Email Setup (Zoho)       │
│  • MX records                │
│  • 2 professional mailboxes  │
│  • Contact form integration  │
└──────────────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│  3. Storage (R2)             │
│  • 5GB bucket                │
│  • CDN configuration         │
└──────────────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│  4. Analytics                │
│  • GA4 property              │
│  • Search Console            │
│  • Basic tracking            │
└──────────────────────────────┘
```

---

## Priority 5: Landing Page (Concierge Model)

### New Messaging

**Headline:** "We build your professional website. You focus on your business."

### Page Structure

```
┌─────────────────────────────────────────┐
│  Hero                                   │
│  • Headline + subheadline               │
│  • Discovery call CTA (Calendly)        │
└─────────────────────────────────────────┘
         │
┌─────────────────────────────────────────┐
│  What's Included                        │
│  • Professional website                 │
│  • Custom domain                        │
│  • Professional email (2 mailboxes)     │
│  • Hosting & SSL                        │
│  • 5GB cloud storage                    │
│  • AI-powered customization             │
│  • Ongoing support                      │
└─────────────────────────────────────────┘
         │
┌─────────────────────────────────────────┐
│  How It Works                           │
│  1. Discovery call (15 min)             │
│  2. We build your site (quickly)            │
│  3. Review & refine together            │
│  4. Launch!                             │
└─────────────────────────────────────────┘
         │
┌─────────────────────────────────────────┐
│  Pricing                                │
│  • EUR 499 setup fee                    │
│  • EUR 39/month (locked in forever)     │
│  • No lock-in, cancel anytime           │
└─────────────────────────────────────────┘
         │
┌─────────────────────────────────────────┐
│  FAQ                                    │
│  • What if I need changes?              │
│  • Do I own my website?                 │
│  • Can I cancel?                        │
└─────────────────────────────────────────┘
         │
┌─────────────────────────────────────────┐
│  Social Proof                           │
│  • (Add after pilot client)             │
└─────────────────────────────────────────┘
```

### Pricing Tiers

| Tier | Setup | Monthly | Target Client |
|------|-------|---------|---------------|
| **Starter** | EUR 499 setup | EUR 39/mo | Launch clients — monthly rate locked in forever |
| **Starter (after launch)** | EUR 499 setup | EUR 49/mo | New clients after launch — same setup, higher monthly |
| **Pro** (coming Q2 2026) | EUR 499 setup | EUR 49/mo | Growing businesses, agencies |
| **Business** (coming Q3 2026) | EUR 699 setup | EUR 79/mo | E-commerce, booking-heavy, payments |

### Permanent Tier Structure

| Tier | Setup | Monthly | Best For |
|------|-------|---------|----------|
| **Starter** | EUR 499 | EUR 39/mo | Freelancers, coaches, solo practitioners |
| **Pro** (Q2 2026) | EUR 499 | EUR 49/mo | Growing businesses, agencies, teams |
| **Business** (Q3 2026) | EUR 699 | EUR 79/mo | E-commerce, course creators, booking-heavy |

**All clients stay at their tier price forever. No surprise increases.**

### What's Included Per Tier (Setup + Ongoing)

#### Starter (€499 setup + €39/mo — rate locked in forever)
**Best for:** Coaches, consultants, therapists, freelancers, personal brands

**Setup includes:**
- Professional multi-page website (3-5 pages)
- Custom domain setup
- 2 professional email addresses
- SSL + hosting
- Contact form (leads saved)
- WhatsApp button
- Google Analytics
- 1 booking integration (Calendly OR Acuity)
- Basic SEO setup

**Dashboard access:**
- Visitors & page views
- Leads list
- Booking notifications
- Basic analytics

---

#### Pro (€499 + €49/mo — coming Q2 2026)
**Best for:** Growing businesses, agencies, restaurants, salons, clinics

**Everything in Standard, plus:**

**Setup includes:**
- Larger website (5-8 pages)
- Google Maps integration
- Instagram feed embed
- Mailchimp newsletter setup
- Multiple booking options
- Google Business profile help
- Facebook Pixel setup
- Advanced SEO setup

**Dashboard access:**
- Full traffic analytics
- Traffic sources breakdown
- Visitor trends over time
- Newsletter subscriber stats

---

#### Business (€699+ setup, €79/mo — coming Q3 2026)
**Best for:** E-commerce, course creators, membership sites, booking-heavy businesses

**Everything in Pro, plus:**

**Setup includes:**
- E-commerce functionality (Shopify/Stripe)
- Course/membership platform setup (Teachable, Kajabi, etc.)
- Payment gateway configuration
- Advanced booking system (multiple services/staff)
- Zapier automation setup
- Custom integrations
- Multi-language support (if needed)

**Dashboard access:**
- Revenue tracking
- Conversion funnels
- Sales analytics
- Inventory notifications (e-commerce)

---

### Tier Comparison Table

| Feature | Standard | Pro | Business |
|---------|----------|-----|----------|
| **WEBSITE** | | | |
| Pages included | 3-5 | 5-8 | 8+ |
| Custom domain | ✅ | ✅ | ✅ |
| Professional emails | 2 | 2 | 4 |
| SSL + hosting | ✅ | ✅ | ✅ |
| Mobile responsive | ✅ | ✅ | ✅ |
| | | | |
| **INTEGRATIONS** | | | |
| Contact form | ✅ | ✅ | ✅ |
| WhatsApp button | ✅ | ✅ | ✅ |
| Google Analytics | ✅ | ✅ | ✅ |
| Booking (1 tool) | ✅ | ✅ | ✅ |
| Google Maps | ❌ | ✅ | ✅ |
| Instagram feed | ❌ | ✅ | ✅ |
| Mailchimp | ❌ | ✅ | ✅ |
| Facebook Pixel | ❌ | ✅ | ✅ |
| Stripe payments | ❌ | ❌ | ✅ |
| Shopify/E-commerce | ❌ | ❌ | ✅ |
| Course platforms | ❌ | ❌ | ✅ |
| Zapier automations | ❌ | ❌ | ✅ |
| Multi-language | ❌ | ❌ | ✅ |
| | | | |
| **DASHBOARD** | | | |
| Visitors & page views | ✅ | ✅ | ✅ |
| Leads management | ✅ | ✅ | ✅ |
| Traffic sources | ❌ | ✅ | ✅ |
| Visitor trends | ❌ | ✅ | ✅ |
| Revenue tracking | ❌ | ❌ | ✅ |
| Conversion funnels | ❌ | ❌ | ✅ |
| | | | |
| **SUPPORT** | | | |
| AI-powered changes | ✅ | ✅ | ✅ |
| Email support | ✅ | ✅ | ✅ |
| WhatsApp support | ❌ | ✅ | ✅ |
| Priority support | ❌ | ❌ | ✅ |

### Example Clients by Tier

**Starter (€499 setup + €39/mo):**
- Life coach with booking page
- Freelance photographer portfolio
- Personal trainer website
- Massage therapist
- Consultant landing page

**Pro (€49/mo — coming Q2 2026):**
- Restaurant with menu + reservations
- Hair salon with team booking
- Dental clinic
- Real estate agent
- Marketing agency

**Business (€79/mo — coming Q3 2026):**
- Online clothing store
- Course creator selling digital products
- Fitness studio with class booking + membership
- Wedding photographer with packages + payments
- SaaS landing page with Stripe checkout

---

## Two Revenue Streams Per Client

### Stream 1: Subscription (Recurring, Predictable)

**What's included by tier:**

| Included | Description |
|----------|-------------|
| Hosting | Cloudflare Pages |
| Email | 2 Zoho mailboxes |
| Storage | Cloudflare R2, 5GB |
| Domain | Management |
| **Standard AI Customizations:** | |
| • Text/copy changes | ✅ Included |
| • Color/theme updates | ✅ Included |
| • Image swaps | ✅ Included |
| • Layout tweaks | ✅ Included |
| • SEO adjustments | ✅ Included |
| • Minor styling | ✅ Included |

### Stream 2: Add-On Quotes (Per Request, Variable)

**Complex changes quoted separately at EUR 50-200+ per request:**

| Complex Work | Price Range |
|--------------|-------------|
| New sections added | EUR 50-100 |
| Structural redesigns | EUR 100-200 |
| New pages | EUR 50-100 |
| New integrations (booking, payment) | EUR 100-200+ |
| Custom functionality | EUR 100-200+ |
| Multi-language setup | EUR 100-150 |

### Smart Escalation Flow

```
Client Describes Change (plain language)
              │
              ▼
┌─────────────────────────────────┐
│    Engine Evaluates Complexity  │
└─────────────────────────────────┘
              │
     ┌────────┴────────┐
     ▼                 ▼
 STANDARD           COMPLEX
     │                 │
     ▼                 ▼
AI Executes       Smart Escalation
Immediately       Message to Client:
(included)        "This needs custom work —
                   we'll follow up."
                       │
                       ▼
              Team Contacts via WhatsApp
                       │
                       ▼
              Scope + Quote (EUR 50-200)
                       │
              ┌────────┴────────┐
              ▼                 ▼
         APPROVED           DECLINED
              │                 │
              ▼                 ▼
         Team Delivers     No hard feelings
         → Revenue              │
              │                 │
              └────────┬────────┘
                       ▼
              Request Logged + Categorized
                       │
                       ▼
              After 50+ similar requests:
              Build into engine as STANDARD
              
              (Today's EUR 100 add-on becomes
               tomorrow's included feature)
```

**Key Insight:** Every add-on delivered manually is R&D for the engine. Add-on revenue funds development that eventually eliminates the need for that add-on.

---

## Unit Economics

### Starter Client (EUR 499 setup + EUR 39/mo)

**Year 1:**
| | Amount |
|---|--------|
| Revenue | EUR 499 + (EUR 39 × 11) = **EUR 928** |
| Costs | EUR 192 |
| **Profit** | **EUR 736** (79% margin) |

**Year 1 with add-ons (2-3 complex requests):**
| | Amount |
|---|--------|
| Revenue | EUR 928 + EUR 200 (add-ons) = **EUR 1,128** |
| Costs | EUR 192 + EUR 30 (AI) = EUR 222 |
| **Profit** | **EUR 906** (80% margin) |

**Year 2+ (recurring only):**
| | Amount |
|---|--------|
| Revenue | EUR 39 × 12 = **EUR 468** |
| Costs | EUR 60 (hosting + AI) |
| **Profit** | **EUR 408** (87% margin) |

### Pro Client (EUR 499 + EUR 49/mo — coming Q2 2026)

**Year 1:**
| | Amount |
|---|--------|
| Revenue | EUR 499 + (EUR 49 × 11) = **EUR 1,038** |
| Costs | EUR 192 |
| **Profit** | **EUR 846** (82% margin) |

**Year 2+:**
| | Amount |
|---|--------|
| Revenue | EUR 588 |
| Costs | EUR 192 |
| **Profit** | **EUR 396** (67% margin) |

### Business Client (EUR 699 + EUR 79/mo — coming Q3 2026)

**Year 1:**
| | Amount |
|---|--------|
| Revenue | EUR 699 + (EUR 79 × 11) = **EUR 1,568** |
| Costs | EUR 250 (more integrations) |
| **Profit** | **EUR 1,318** (84% margin) |

---

## Landing Page Pricing

### Pricing Section Copy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│                              PRICING                                     │
│                                                                          │
│   ┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐│
│   │  STARTER ⭐ POPULAR │ │    PRO (Q2 2026)    │ │  BUSINESS (Q3 2026) ││
│   │                     │ │    Coming Soon      │ │    Coming Soon      ││
│   │   €499 setup        │ │   TBD setup         │ │   TBD+ setup        ││
│   │   €39/month         │ │   TBD/month         │ │   TBD/month         ││
│   │ Rate locked forever │ │                     │ │                     ││
│   │                     │ │                     │ │                     ││
│   │   ✓ Professional    │ │   Everything in     │ │   Everything in     ││
│   │     website         │ │   Standard, plus:   │ │   Pro, plus:        ││
│   │   ✓ Custom domain   │ │                     │ │                     ││
│   │   ✓ 2 email boxes   │ │   ✓ Mailchimp       │ │   ✓ Stripe payments ││
│   │   ✓ Hosting + SSL   │ │   ✓ Instagram feed  │ │   ✓ Shopify         ││
│   │   ✓ Google Analytics│ │   ✓ Google Maps     │ │   ✓ Zapier          ││
│   │   ✓ Contact form    │ │   ✓ Traffic trends  │ │   ✓ Revenue tracking││
│   │   ✓ WhatsApp button │ │   ✓ Full analytics  │ │   ✓ Conversion      ││
│   │   ✓ 1 booking tool  │ │                     │ │     funnels         ││
│   │   ✓ Basic analytics │ │                     │ │                     ││
│   │                     │ │                     │ │                     ││
│   │   Best for:         │ │   Best for:         │ │   Best for:         ││
│   │   Freelancers,      │ │   Growing business, │ │   Online stores,    ││
│   │   coaches, solo     │ │   agencies, teams   │ │   booking-heavy     ││
│   │                     │ │                     │ │                     ││
│   │   [Get Started]     │ │   [Get Started]     │ │   [Get Started]     ││
│   └─────────────────────┘ └─────────────────────┘ └─────────────────────┘│
│                                                                          │
│   ✓ First month FREE on all plans                                       │
│   ✓ No lock-in — cancel anytime                                         │
│   ✓ You own everything — export anytime                                 │
│   ✓ Standard changes included in all plans                              │
│                                                                          │
│                    [Book Your Free Discovery Call]                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Priority 6: Client-Facing Post-Delivery Interface

### After Site Launch

Clients get access to a simple interface where they can:

1. **Request Changes** - Chat with AI to describe modifications
2. **View Site** - Live preview of their site
3. **Download Assets** - Get their source code, images, etc.
4. **Manage Domain** - DNS settings (advanced users)
5. **View Analytics** - Basic traffic stats (if GA connected)

### Interface Design

```
┌───────────────────────────────────────────────────────────────────┐
│  [Logo]  My Website  [Preview] [✏️ Edit Website] [Settings] [Help] │
├───────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │                                                             │   │
│  │                    Live Preview                             │   │
│  │                                                             │   │
│  │                                                             │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                    │
│  ┌──────────────────────┐  ┌─────────────────────────────────┐   │
│  │  Quick Actions       │  │  💬 Quick Change                │   │
│  │                      │  │  ______________________________ │   │
│  │  [✏️ Edit Website]   │  │  [Send]                         │   │
│  │  [📊 Analytics]      │  │                                 │   │
│  │  [📁 Download Files] │  │  Recent: "Change hero image"   │   │
│  │  [🌐 Domain Settings]│  │                                 │   │
│  └──────────────────────┘  └─────────────────────────────────┘   │
│                                                                    │
└───────────────────────────────────────────────────────────────────┘
```

### Dashboard → Editor Flow

```
Client Dashboard
       │
       ├──→ [Quick Change Chat] ──→ Simple text requests
       │                            (handled by API, no editor)
       │
       └──→ [✏️ Edit Website] ──→ Full Editor Experience
                                    │
                                    ▼
                    ┌─────────────────────────────────┐
                    │         FULL EDITOR             │
                    │  ┌─────────┬─────────────────┐  │
                    │  │         │                 │  │
                    │  │  Chat   │    Preview      │  │
                    │  │  Panel  │    (Live)       │  │
                    │  │         │                 │  │
                    │  │         │                 │  │
                    │  ├─────────┼─────────────────┤  │
                    │  │  File   │    Code View    │  │
                    │  │  Tree   │    (Optional)   │  │
                    │  └─────────┴─────────────────┘  │
                    │                                 │
                    │  [💬 Describe changes...]      │
                    │  [Publish Changes]              │
                    └─────────────────────────────────┘
```

### Two Customization Modes

| Mode | Access | For | Features |
|------|--------|-----|----------|
| **Quick Change** | Dashboard chat box | Simple requests | "Change phone number", "Update hours" |
| **Full Editor** | "Edit Website" button | Complex changes | Live preview, file browser, full AI chat |

### Editor Access Control

```typescript
// Client can only access their own project
// Route: /editor/[projectId]

async function canAccessEditor(userId: string, projectId: string) {
  const project = await getProject(projectId);
  
  // Team members can access any project
  if (isTeamMember(userId)) return true;
  
  // Clients can only access their own
  return project.clerk_user_id === userId;
}
```

### Editor Features for Clients

| Feature | Available | Notes |
|---------|-----------|-------|
| AI Chat | ✅ Yes | Main interaction method |
| Live Preview | ✅ Yes | See changes in real-time |
| File Browser | ✅ Yes | View structure (read-only for non-tech) |
| Code View | ⚙️ Optional | Toggle for advanced users |
| Publish | ✅ Yes | Push changes live |
| Rollback | ✅ Yes | Undo last publish |
| Export/Download | ✅ Yes | Get full source code |

### Key Principles

- **Simple:** Non-technical users can use it
- **No Lock-In:** Export button always visible
- **AI-First:** Changes via natural language
- **Human Fallback:** "Talk to a human" option

---

## Priority 8: Business Integrations

### Core Integrations (Must Have at Launch)

| Integration | Purpose | Provider | Complexity |
|-------------|---------|----------|------------|
| **Calendly** | Booking/scheduling | Calendly API | Medium |
| **Google Analytics** | Traffic tracking | GA4 | Easy |
| **Mailchimp** | Email marketing | Mailchimp API | Medium |
| **Contact Forms** | Lead capture | Native + email | Easy |

### Phase 2 Integrations (Post-Launch)

| Integration | Purpose | Provider | Complexity |
|-------------|---------|----------|------------|
| **Stripe** | Payments | Stripe API | Medium |
| **Google Maps** | Location/directions | Maps Embed | Easy |
| **Instagram Feed** | Social proof | Instagram API | Medium |
| **WhatsApp Button** | Direct contact | WhatsApp Link | Easy |
| **Facebook Pixel** | Ad tracking | Meta Pixel | Easy |
| **Hotjar/Clarity** | Heatmaps | Script embed | Easy |

### Future Integrations (Business Tier)

| Integration | Purpose | Provider |
|-------------|---------|----------|
| **Shopify** | E-commerce | Shopify Buy Button |
| **Square** | Appointments + Payments | Square API |
| **Acuity** | Advanced scheduling | Acuity API |
| **ConvertKit** | Email sequences | ConvertKit API |
| **Zapier** | Automation | Zapier Webhooks |

### Integration Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   CLIENT DASHBOARD                       │
│  ┌─────────────────────────────────────────────────┐    │
│  │              INTEGRATIONS TAB                    │    │
│  │                                                  │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │    │
│  │  │ Calendly │ │ Mailchimp│ │ Analytics│        │    │
│  │  │ ✅ Active │ │ ⚙️ Setup │ │ ✅ Active │        │    │
│  │  └──────────┘ └──────────┘ └──────────┘        │    │
│  │                                                  │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │    │
│  │  │ Stripe   │ │ Instagram│ │ WhatsApp │        │    │
│  │  │ 🔒 Pro   │ │ ➕ Add   │ │ ✅ Active │        │    │
│  │  └──────────┘ └──────────┘ └──────────┘        │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### Integration Setup Flow (Client Dashboard)

```
Client clicks "Add Integration"
         │
         ▼
┌─────────────────────────────────┐
│   Select Integration Type       │
│   [Calendly] [Mailchimp] [GA4]  │
└─────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│   OAuth or API Key Entry        │
│   • Calendly: OAuth connect     │
│   • Mailchimp: OAuth connect    │
│   • GA4: Measurement ID         │
└─────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│   Configuration                 │
│   • Calendly: Select event type │
│   • Mailchimp: Select list      │
│   • GA4: Confirm tracking       │
└─────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│   AI Embeds Integration         │
│   • Adds to appropriate pages   │
│   • Updates template            │
│   • Publishes automatically     │
└─────────────────────────────────┘
```

### Secure Integration Architecture

**All integration credentials are stored encrypted at rest using Supabase Vault (or similar).**

```
┌─────────────────────────────────────────────────────────────────┐
│                     INTEGRATION ARCHITECTURE                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   CLIENT SITE                    FLOWSTARTER BACKEND            │
│   ┌─────────────┐               ┌─────────────────────────┐     │
│   │             │               │                         │     │
│   │  React      │    API        │  Integration Service    │     │
│   │  Components │ ──────────────▶  (Server-side)          │     │
│   │             │               │                         │     │
│   │  • Calendly │               │  • Never expose keys    │     │
│   │    Widget   │               │  • Proxy all requests   │     │
│   │  • Mailchimp│               │  • Handle OAuth flows   │     │
│   │    Form     │               │                         │     │
│   │  • Contact  │               └───────────┬─────────────┘     │
│   │    Form     │                           │                   │
│   └─────────────┘                           │                   │
│                                             ▼                   │
│                                 ┌─────────────────────────┐     │
│                                 │   SUPABASE VAULT        │     │
│                                 │   (Encrypted at Rest)   │     │
│                                 │                         │     │
│                                 │   • API keys            │     │
│                                 │   • OAuth tokens        │     │
│                                 │   • Refresh tokens      │     │
│                                 │   • Webhook secrets     │     │
│                                 └───────────┬─────────────┘     │
│                                             │                   │
│                                             ▼                   │
│                                 ┌─────────────────────────┐     │
│                                 │   EXTERNAL SERVICES     │     │
│                                 │                         │     │
│                                 │   • Calendly API        │     │
│                                 │   • Mailchimp API       │     │
│                                 │   • Stripe API          │     │
│                                 │   • GA4 API             │     │
│                                 └─────────────────────────┘     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Secrets Storage (Supabase Vault)

```sql
-- Using Supabase Vault for encrypted storage
-- Keys are encrypted at rest with AES-256-GCM

-- Store a secret
SELECT vault.create_secret(
  'calendly_api_key_project_123',
  'sk_live_xxxxxxxxxxxxx',
  'Calendly API key for project 123'
);

-- Retrieve a secret (only from server-side)
SELECT decrypted_secret 
FROM vault.decrypted_secrets 
WHERE name = 'calendly_api_key_project_123';
```

### Integration Storage (Supabase)

```typescript
// Public integration config (non-sensitive)
interface ProjectIntegration {
  id: string;
  project_id: string;
  type: 'calendly' | 'mailchimp' | 'ga4' | 'stripe' | 'instagram';
  status: 'active' | 'inactive' | 'error';
  
  // Non-sensitive config (can be in regular table)
  config: {
    calendly_username?: string;      // Public username
    calendly_event_slug?: string;    // Public event identifier
    mailchimp_list_id?: string;      // List identifier
    ga4_measurement_id?: string;     // Public measurement ID
    stripe_publishable_key?: string; // Public key (safe to expose)
  };
  
  // Reference to vault secrets (NOT the actual values)
  vault_refs: {
    api_key?: string;       // vault.secret_name
    access_token?: string;  // vault.secret_name
    refresh_token?: string; // vault.secret_name
    webhook_secret?: string;// vault.secret_name
  };
  
  oauth_expires_at?: number;
  created_at: timestamp;
  updated_at: timestamp;
}
```

### Dedicated React Components

Each integration has a dedicated React component that communicates with our API (never directly with third-party services):

```typescript
// components/integrations/CalendlyWidget.tsx
interface CalendlyWidgetProps {
  projectId: string;
  eventType?: string;
  buttonText?: string;
}

export function CalendlyWidget({ projectId, eventType, buttonText }: CalendlyWidgetProps) {
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);

  useEffect(() => {
    // Fetch embed URL from our API (not directly from Calendly)
    fetch(`/api/integrations/calendly/${projectId}/embed-url`)
      .then(res => res.json())
      .then(data => setEmbedUrl(data.url));
  }, [projectId]);

  if (!embedUrl) return <ContactFallback />;

  return (
    <button onClick={() => openCalendlyPopup(embedUrl)}>
      {buttonText || "Book a Call"}
    </button>
  );
}
```

```typescript
// components/integrations/MailchimpForm.tsx
interface MailchimpFormProps {
  projectId: string;
  title?: string;
}

export function MailchimpForm({ projectId, title }: MailchimpFormProps) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setStatus('loading');
    
    // Submit through our API (we handle Mailchimp server-side)
    const res = await fetch(`/api/integrations/mailchimp/${projectId}/subscribe`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    
    setStatus(res.ok ? 'success' : 'error');
  };

  return (
    <form onSubmit={handleSubmit}>
      <h3>{title || "Subscribe to our newsletter"}</h3>
      <input 
        type="email" 
        value={email} 
        onChange={e => setEmail(e.target.value)}
        placeholder="your@email.com"
      />
      <button type="submit" disabled={status === 'loading'}>
        {status === 'loading' ? 'Subscribing...' : 'Subscribe'}
      </button>
      {status === 'success' && <p>Thanks for subscribing!</p>}
    </form>
  );
}
```

```typescript
// components/integrations/ContactForm.tsx
interface ContactFormProps {
  projectId: string;
  fields?: ('name' | 'email' | 'phone' | 'message')[];
}

export function ContactForm({ projectId, fields }: ContactFormProps) {
  const [formData, setFormData] = useState({});
  
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    
    // Submit to our API → saves to Supabase leads + notifies client
    await fetch(`/api/integrations/contact/${projectId}/submit`, {
      method: 'POST',
      body: JSON.stringify(formData),
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* Dynamic fields based on config */}
    </form>
  );
}
```

### Integration API Routes

```typescript
// Server-side API routes that handle all integration communication

// /api/integrations/calendly/[projectId]/embed-url
export async function GET(req, { params }) {
  const integration = await getIntegration(params.projectId, 'calendly');
  
  // Return public embed URL (no secrets exposed)
  return Response.json({
    url: `https://calendly.com/${integration.config.calendly_username}/${integration.config.calendly_event_slug}`
  });
}

// /api/integrations/mailchimp/[projectId]/subscribe
export async function POST(req, { params }) {
  const { email } = await req.json();
  const integration = await getIntegration(params.projectId, 'mailchimp');
  
  // Get API key from vault (server-side only)
  const apiKey = await vault.getSecret(integration.vault_refs.api_key);
  
  // Call Mailchimp API server-side
  await mailchimp.lists.addMember(integration.config.mailchimp_list_id, {
    email_address: email,
    status: 'subscribed'
  }, { apiKey });
  
  // Also save to our leads table
  await saveLead(params.projectId, { email, source: 'newsletter' });
  
  return Response.json({ success: true });
}

// /api/integrations/contact/[projectId]/submit
export async function POST(req, { params }) {
  const formData = await req.json();
  
  // Save to Supabase leads table
  const lead = await saveLead(params.projectId, {
    ...formData,
    source: 'contact_form'
  });
  
  // Notify client via email
  await sendLeadNotification(params.projectId, lead);
  
  // Forward to Mailchimp if configured
  const mailchimpIntegration = await getIntegration(params.projectId, 'mailchimp');
  if (mailchimpIntegration && formData.email) {
    await addToMailchimp(mailchimpIntegration, formData.email);
  }
  
  return Response.json({ success: true });
}
```

### Security Principles

| Principle | Implementation |
|-----------|----------------|
| **Keys never in client** | All API keys in Supabase Vault |
| **Encrypted at rest** | AES-256-GCM encryption |
| **Server-side only** | API routes proxy all integration calls |
| **OAuth token refresh** | Automatic refresh handled server-side |
| **Audit logging** | All vault access logged |
| **Least privilege** | Each project only accesses own secrets |

### Vault Secret Naming Convention

```
{integration}_{secret_type}_project_{project_id}

Examples:
- calendly_api_key_project_abc123
- mailchimp_access_token_project_abc123
- mailchimp_refresh_token_project_abc123
- stripe_secret_key_project_abc123
- ga4_service_account_project_abc123
```

### Integration UI in Templates

Each template has pre-built integration slots:

```astro
<!-- Hero section with Calendly -->
<section id="hero">
  <h1>{content.headline}</h1>
  <p>{content.subheadline}</p>
  
  {#if integrations.calendly}
    <CalendlyButton url={integrations.calendly.url} />
  {:else}
    <ContactButton />
  {/if}
</section>

<!-- Footer with Mailchimp -->
<footer>
  {#if integrations.mailchimp}
    <NewsletterForm action={integrations.mailchimp.formAction} />
  {/if}
</footer>

<!-- Analytics (always in head) -->
<head>
  {#if integrations.ga4}
    <GoogleAnalytics id={integrations.ga4.measurementId} />
  {/if}
</head>
```

### Integration Pricing

| Tier | Monthly | Included Integrations |
|------|---------|----------------------|
| **Starter** | €39/mo | GA4, Contact Form, WhatsApp, 1 booking tool |
| **Pro** (Q2 2026) | €49/mo | All above + Mailchimp, Instagram, Maps |
| **Business** (Q3 2026) | €79/mo | All above + Stripe, Shopify, Zapier, advanced |

### Integration Setup Process

**At Launch: Team Sets Up Everything Manually**

We don't just configure integrations — we help clients **create accounts** if they don't have them.

```
Discovery Call
     │
     ▼
"Do you need online booking? We'll set up Calendly for you."
"Want to collect emails? We'll create your Mailchimp account."
"We'll set up Google Analytics — you don't need to do anything."
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  TEAM CREATES ACCOUNTS (if client doesn't have them)        │
│                                                              │
│  • Calendly: Create account, set up event types, availability│
│  • Mailchimp: Create account, design signup form, welcome    │
│  • GA4: Create property, configure tracking                  │
│  • Google Business: Help claim/create listing                │
│  • Zoho Mail: Set up business email (included)               │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
Team connects to website + embeds
     │
     ▼
Client gets login credentials for all accounts
     │
     ▼
Client sees everything working on their site
```

### Account Creation Checklist (Per Client)

| Service | We Create? | Client Needs | Notes |
|---------|------------|--------------|-------|
| **Zoho Mail** | ✅ Yes | Nothing | Included in subscription |
| **Google Analytics** | ✅ Yes | Nothing | We create + own property |
| **Calendly** | ✅ Yes | Their availability | Free tier usually enough |
| **Mailchimp** | ✅ Yes | Nothing | Free tier up to 500 contacts |
| **Google Business** | 🤝 Help | Verify ownership | Client must verify via postcard/phone |
| **Stripe** | 🤝 Help | Bank details, ID | Client must complete verification |
| **Instagram** | ❌ No | Existing account | We just connect/embed |
| **WhatsApp Business** | 🤝 Help | Phone number | Client verifies |

### Credentials Handoff

After setup, client receives:

```
Email: "Your Website Accounts"

Hi [Client Name],

Your website is ready! Here are your account logins:

🌐 WEBSITE DASHBOARD
flowstarter.app/dashboard
(Login with this email)

📧 BUSINESS EMAIL
webmail.zoho.com
Email: hello@yourdomain.com
Password: [secure password]

📅 CALENDLY (Booking)
calendly.com
Email: [client email]
Password: [we set or they chose]

📊 GOOGLE ANALYTICS
analytics.google.com
(Shared access via their Google account)

📬 MAILCHIMP (Email List)
mailchimp.com
Email: [client email]
Password: [we set or they chose]

Please change passwords after first login.
We're here if you need help with any of these!

— Flowstarter Team
```

### Why This Matters

Most small business owners:
- Don't know what tools they need
- Don't know how to set them up
- Get overwhelmed by options

**We remove all friction.** They describe their business, we give them a working website with all the tools configured.

**Phase 2+: Client Self-Service (Dashboard)**

Later, clients can:
- View integration status
- Update API keys if needed
- Connect new integrations via OAuth
- See basic analytics

**What always requires team (Add-on quote):**
- Custom integration placement
- Advanced Zapier workflows
- Multi-step booking flows
- Payment gateway setup (first time)

### Lead Capture & Storage

**All leads are saved to Supabase — not just emailed!**

```
Contact Form Submission
         │
         ▼
┌─────────────────────────────────┐
│   1. Save to Supabase           │
│   • leads table                 │
│   • Linked to project_id        │
│   • Timestamp + source          │
└─────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│   2. Notify Client              │
│   • Email notification          │
│   • (Optional) WhatsApp         │
└─────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│   3. Forward to Integrations    │
│   • Add to Mailchimp list       │
│   • Create Calendly booking     │
│   • (if configured)             │
└─────────────────────────────────┘
```

### Leads Table (Supabase)

```sql
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES projects(id),
  
  -- Contact info
  name TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT,
  
  -- Source tracking
  source TEXT DEFAULT 'contact_form',  -- 'contact_form', 'newsletter', 'booking'
  page_url TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  
  -- Status
  status TEXT DEFAULT 'new',  -- 'new', 'contacted', 'converted', 'archived'
  notes TEXT,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: Clients can only see their own leads
CREATE POLICY "Users can view own project leads" ON leads
  FOR SELECT USING (
    project_id IN (
      SELECT id FROM projects WHERE clerk_user_id = auth.uid()
    )
  );
```

### Client Dashboard: Analytics View

**Clients see key metrics without leaving the dashboard.**

```
┌─────────────────────────────────────────────────────────────────┐
│  ANALYTICS                                    [This Week ▼]     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────┐│
│  │   VISITORS   │ │  PAGE VIEWS  │ │    LEADS     │ │ BOOKINGS ││
│  │              │ │              │ │              │ │          ││
│  │     247      │ │     892      │ │      12      │ │    5     ││
│  │   ↑ 23%      │ │   ↑ 15%      │ │   ↑ 50%      │ │  ↑ 25%   ││
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────┘│
│                                                                  │
│  VISITORS OVER TIME                                              │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │     50│                                            ╭──╮     ││
│  │       │                              ╭─╮    ╭─╮   │  │     ││
│  │     25│         ╭─╮    ╭─╮    ╭─╮   │ │   │  │  │  │     ││
│  │       │   ╭─╮  │ │   │ │   │ │  │ │   │  │  │  │     ││
│  │      0│───┴─┴──┴─┴───┴─┴───┴─┴──┴─┴───┴──┴──┴──┴─────││
│  │        Mon  Tue  Wed  Thu  Fri  Sat  Sun              ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  TOP PAGES                         │  TRAFFIC SOURCES           │
│  ┌─────────────────────────────┐   │  ┌─────────────────────┐   │
│  │ /              45%  ████▌   │   │  │ Google     52% ████▌│   │
│  │ /services      28%  ███     │   │  │ Direct     31% ███  │   │
│  │ /contact       15%  █▌      │   │  │ Instagram  12% █    │   │
│  │ /about          8%  █       │   │  │ Facebook    5% ▌    │   │
│  └─────────────────────────────┘   │  └─────────────────────┘   │
│                                                                  │
│  RECENT ACTIVITY                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 🎯 New lead: Maria Ionescu                      2 hours ago ││
│  │ 📅 New booking: John Smith (consultation)       5 hours ago ││
│  │ 👀 Peak traffic: 48 visitors                      Yesterday ││
│  │ 📧 Newsletter signup: ana@email.com             2 days ago  ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│              [View Full Analytics in Google Analytics →]        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Analytics Data Sources

| Metric | Source | How We Get It |
|--------|--------|---------------|
| Visitors | GA4 | GA4 Data API |
| Page Views | GA4 | GA4 Data API |
| Leads | Supabase | Our leads table |
| Bookings | Calendly | Calendly API |
| Newsletter Signups | Mailchimp | Mailchimp API |
| Traffic Sources | GA4 | GA4 Data API |
| Top Pages | GA4 | GA4 Data API |

### Analytics Implementation

```typescript
// Supabase table for cached analytics (avoid hitting GA4 API constantly)
interface AnalyticsSnapshot {
  id: string;
  project_id: string;
  date: string;  // YYYY-MM-DD
  
  // From GA4
  visitors: number;
  page_views: number;
  top_pages: { path: string; views: number }[];
  traffic_sources: { source: string; visitors: number }[];
  
  // From our data
  leads_count: number;
  bookings_count: number;
  newsletter_signups: number;
  
  // Metadata
  fetched_at: timestamp;
}

// Cron job: Fetch GA4 data daily
async function syncAnalytics(projectId: string) {
  const ga4Data = await fetchGA4Data(project.ga4_property_id);
  const leadsCount = await countLeads(projectId, today);
  const bookingsCount = await fetchCalendlyBookings(project.calendly_url, today);
  
  await supabase.from('analytics_snapshots').upsert({
    project_id: projectId,
    date: today,
    visitors: ga4Data.visitors,
    page_views: ga4Data.pageViews,
    // ... etc
  });
}
```

### Analytics by Tier

| Metric | Starter (€39/mo) | Pro (Q2 2026) | Business (Q3 2026) |
|--------|----------------|-----------|----------------|
| Visitors | ✅ | ✅ | ✅ |
| Page Views | ✅ | ✅ | ✅ |
| Leads | ✅ | ✅ | ✅ |
| Top Pages | ✅ | ✅ | ✅ |
| Traffic Sources | ❌ | ✅ | ✅ |
| Visitor Trends | ❌ | ✅ | ✅ |
| Bookings | ✅ | ✅ | ✅ |
| Revenue Tracking | ❌ | ❌ | ✅ |
| Conversion Funnels | ❌ | ❌ | ✅ |

### Why In-Dashboard Analytics?

1. **Simplicity** - Clients don't need to learn GA4
2. **Unified View** - Website + leads + bookings in one place
3. **Actionable** - Show what matters, hide complexity
4. **Engagement** - Reason to log into dashboard regularly

---

## Analytics Dashboard — ADDED TO PILOT SCOPE

**Analytics dashboard moved UP from Phase 4 to Phase 2-3. Included in pilot launch.**

**Rationale:** A dashboard with real data transforms Flowstarter from "you have a website" to "you have a business tool." This is a key differentiator — no competitor at this price point shows clients their own analytics in a branded dashboard.

### Analytics Architecture

```
Client's Live Site
         │
         ▼
GA4 Tracking Script (injected per project)
         │
         ▼
Google Analytics 4 (Google's infrastructure)
         │
         ▼
GA4 Data API (server-side, via service account)
         │
         ▼
Flowstarter Backend (caches + transforms)
         │
         ▼
Client Dashboard (clean, simple, branded)
```

**Additionally:**
```
Contact Form Submissions
         │
         ▼
Supabase leads table (already built)
         │
         ▼
Client Dashboard (leads tab)
```

Two data sources, one dashboard. GA4 for traffic, Supabase for leads.

### GA4 Integration Details

**Setup Per Client (Manual for Pilot):**
1. Create GA4 property for client's domain
2. Add Flowstarter service account as viewer
3. Inject GA4 tracking script into client site `<head>` during publish
4. Store GA4 property ID in Supabase project record

**API Access (Server-Side Only):**
- Use **Google Analytics Data API v1** (not old Universal Analytics)
- Authenticate via **service account** (no OAuth consent screen needed)
- Service account has read-only access to all client GA4 properties
- All API calls from Flowstarter backend, never from client browser

**Data Fetching Strategy:**
- **Not real-time.** Cache GA4 data server-side, refresh every 4-6 hours
- Store cached metrics in Supabase for fast dashboard loads
- Avoids GA4 API rate limits and keeps dashboard snappy
- Clients don't need real-time — daily/weekly trends are the value

### Dashboard Metrics (Pilot Scope)

**Card 1: Visitors**
```
┌─────────────────────────┐
│  VISITORS (30 days)     │
│                         │
│         247             │
│    ↑ 23% vs last month  │
│                         │
│  ▁▂▃▄▅▆▇█▇▆▅ (trend)    │
└─────────────────────────┘
```
- Source: GA4 → `activeUsers` metric
- Period: Last 30 days + comparison
- Trend: Sparkline showing daily visitors

**Card 2: Page Views**
```
┌─────────────────────────┐
│  PAGE VIEWS (30 days)   │
│                         │
│         892             │
│    ↑ 15% vs last month  │
│                         │
│  Top Pages:             │
│  1. / (342)             │
│  2. /services (198)     │
│  3. /about (156)        │
└─────────────────────────┘
```
- Source: GA4 → `screenPageViews` + `pagePath`
- Period: Last 30 days
- Top pages: Top 5 by views

**Card 3: Leads**
```
┌─────────────────────────┐
│  LEADS (30 days)        │
│                         │
│          12             │
│    ↑ 50% vs last month  │
│                         │
│  Recent:                │
│  • Ion Popescu (2h ago) │
│  • Maria Ionescu (1d)   │
│  • Andrei Vasile (3d)   │
└─────────────────────────┘
```
- Source: Supabase `leads` table
- Period: Last 30 days count + recent list
- Each lead: name, email, phone, message, timestamp

### Dashboard Layout (Pilot)

```
┌──────────────────────────────────────────────┐
│  📊 Dashboard            [Last 30 days ▼]    │
├──────────────┬──────────────┬────────────────┤
│   VISITORS   │  PAGE VIEWS  │     LEADS      │
│     247      │     892      │      12        │
│    ↑ 23%     │    ↑ 15%     │    ↑ 50%       │
├──────────────┴──────────────┴────────────────┤
│                                              │
│  📈 Visitor Trend (30 day chart)             │
│  ▁▂▃▂▄▅▆▅▇█▇▆▅▄▅▆▇▆▅▄▃▄▅▆▇█▇▆▅               │
│                                              │
├──────────────────────────────────────────────┤
│  📄 Top Pages        │  👤 Recent Leads      │
│  1. / (342 views)    │  Ion P. (2h ago)      │
│  2. /services (198)  │  Maria I. (1d)        │
│  3. /about (156)     │  Andrei V. (3d)       │
│  4. /contact (112)   │  Elena M. (5d)        │
│  5. /pricing (84)    │  Radu C. (1w)         │
├──────────────────────────────────────────────┤
│  [💬 Request Change]    [✏️ Edit Website]    │
└──────────────────────────────────────────────┘
```

### Leads System (CRM-lite)

**Contact Form Flow:**
```
Client site contact form
         │
         ▼
POST /api/integrations/contact-form/{projectId}
         │
         ▼
Supabase leads table:
{
  id, project_id, name, email, phone, message,
  source: "contact_form" | "calendly" | "manual",
  utm_source, utm_medium, utm_campaign,
  status: "new" | "contacted" | "converted",
  created_at
}
         │
         ▼
Notification to client:
- Email: "New lead: Ion Popescu"
- Optional: WhatsApp notification
```

**Leads Tab Features:**
- List of all leads, newest first
- Filter by status (new / contacted / converted)
- Click to see full details
- Mark as contacted / converted
- Export to CSV

This is NOT a full CRM. It's "here are the people who contacted you through your website." Simple, useful, enough.

### Analytics Implementation Plan

**Phase 2 (March-April): Build It**

*Week 1: GA4 Backend*
- Set up Google Cloud project + service account
- Implement GA4 Data API wrapper
- Caching layer (Supabase, refresh every 4-6h)
- API route: `GET /api/analytics/{projectId}`

*Week 2: Dashboard UI*
- 3 metric cards with trend indicators
- Visitor trend sparkline (recharts)
- Top pages list
- Recent leads list
- Period selector (7 / 30 / 90 days)
- Responsive layout

*Week 3: Leads System*
- Contact form component + handler
- Lead notification emails
- Leads list with status management
- CSV export

**Phase 3 (April-May): Polish for Pilot**
- Test with real GA4 data
- Handle edge cases (new site = friendly empty state)
- Pilot client onboarded with GA4 property

### What Analytics Does NOT Include (Phase 4+)

| Feature | Phase |
|---------|-------|
| Traffic sources breakdown | Phase 4 |
| Conversion funnels | Phase 4 (Business) |
| Revenue tracking | Phase 4 (Business + Shopify) |
| A/B testing | Phase 5 |
| Custom reports | Phase 5 |
| Calendly booking analytics | Phase 4 |

### Updated Pilot Scope Lock

Until pilot client is live in May, **6 things matter:**

1. ✅ **Customization engine works reliably** — client describes change, AI executes
2. ✅ **3 templates exist and are AI-friendly** — clean structure, predictable patterns
3. ✅ **4 integrations work** — contact form, WhatsApp, GA4, Calendly
4. ✅ **Publish pipeline works** — Convex → Cloudflare Pages, with rollback
5. ✅ **Internal site generation flow** — template + info → AI content → preview
6. ✅ **Analytics dashboard with real data** — visitors, pageviews, leads ← NEW

**"Build the engine. Show the results."**

### Client Dashboard: Leads View

```
┌─────────────────────────────────────────────────────────────────┐
│  LEADS                                           [Export CSV]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Filter: [All ▼]  [This Week ▼]  🔍 Search...                   │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ ● NEW    Maria Ionescu    maria@email.com    2 hours ago   ││
│  │          "I'd like to book a consultation for next week"    ││
│  │          [Mark Contacted] [Archive]                         ││
│  ├─────────────────────────────────────────────────────────────┤│
│  │ ● NEW    John Smith       john@gmail.com     5 hours ago   ││
│  │          "What are your prices for a full session?"         ││
│  │          [Mark Contacted] [Archive]                         ││
│  ├─────────────────────────────────────────────────────────────┤│
│  │ ✓ CONTACTED  Ana Pop     ana@company.ro     Yesterday      ││
│  │          "Newsletter signup"                                ││
│  │          [Mark Converted] [Archive]                         ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Showing 3 of 24 leads                        [Load More]       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Lead Notifications

**Email to Client (Instant):**
```
Subject: 🎉 New lead from your website!

Hi [Client Name],

You have a new contact form submission:

Name: Maria Ionescu
Email: maria@email.com
Phone: +40 722 123 456
Message: "I'd like to book a consultation for next week"

View all leads: [Dashboard Link]

— Your Website
```

**Optional: WhatsApp Notification**
If client enables, send WhatsApp message for instant notification.

---

## Priority 9: Landing Page Revamp

### New Customer Journey

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                  │
│   1. DISCOVER          2. CALL           3. BUILD    4. LAUNCH  │
│   ─────────────────────────────────────────────────────────────  │
│                                                                  │
│   Land on page    →   Book call    →   We build  →   Go live!  │
│   See value           15 min           fast       + Pay     │
│   Read pricing        Discovery        Your site      Setup fee │
│                       Discuss needs    ready          + Monthly │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Landing Page Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                  │
│                         NAVIGATION                               │
│   [Logo]              [How It Works] [Pricing] [FAQ] [Book Call]│
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                           HERO                                   │
│                                                                  │
│         "Your Professional Website,                              │
│          Delivered Fast"                                         │
│                                                                  │
│         We handle everything — you focus on your business.       │
│         No DIY. No templates to figure out. No tech headaches.   │
│                                                                  │
│         [Book Your Free Discovery Call]                          │
│                                                                  │
│         ✓ Professional website  ✓ Custom domain                  │
│         ✓ Business email        ✓ Ongoing updates                │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                      HOW IT WORKS                                │
│                                                                  │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐     │
│   │    1    │    │    2    │    │    3    │    │    4    │     │
│   │  📞     │ →  │  🎨     │ →  │  ✅     │ →  │  🚀     │     │
│   │ Call    │    │ Build   │    │ Review  │    │ Launch  │     │
│   └─────────┘    └─────────┘    └─────────┘    └─────────┘     │
│                                                                  │
│   15-min call     We create      You review     Go live!        │
│   to understand   your site      and request    Pay setup       │
│   your business   in fast    any changes    + start monthly │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                    WHAT'S INCLUDED                               │
│                                                                  │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐│
│   │ 🌐 Website      │  │ 📧 Email        │  │ 🔒 Hosting      ││
│   │                 │  │                 │  │                 ││
│   │ Professional    │  │ 2 business      │  │ Fast, secure    ││
│   │ multi-page site │  │ email addresses │  │ unlimited       ││
│   │ mobile-ready    │  │ you@domain.com  │  │ bandwidth       ││
│   └─────────────────┘  └─────────────────┘  └─────────────────┘│
│                                                                  │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐│
│   │ 🎯 Domain       │  │ 🤖 AI Updates   │  │ 📊 Analytics    ││
│   │                 │  │                 │  │                 ││
│   │ Your own        │  │ Request changes │  │ See who visits  ││
│   │ .com/.ro domain │  │ in plain words  │  │ your site       ││
│   │ (we help pick)  │  │ we handle rest  │  │ Google Analytics││
│   └─────────────────┘  └─────────────────┘  └─────────────────┘│
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                       INTEGRATIONS                               │
│                                                                  │
│   Connect the tools you already use:                             │
│                                                                  │
│   [Calendly]  [Mailchimp]  [Stripe]  [Instagram]  [WhatsApp]    │
│                                                                  │
│   All integrations included. We set them up for you.             │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                        PRICING                                   │
│                                                                  │
│   ┌───────────────┐ ┌───────────────┐ ┌───────────────┐         │
│   │STARTER⭐POPULAR│ │  PRO (Q2 2026)│ │BIZ (Q3 2026)  │         │
│   │               │ │  Coming Soon  │ │  Coming Soon  │         │
│   │  €499 setup   │ │  TBD setup    │ │  TBD+ setup   │         │
│   │  €39/month    │ │  TBD/month    │ │  TBD/month    │         │
│   │ rate locked   │ │  Q2 2026      │ │  Q3 2026      │         │
│   │               │ │               │ │               │         │
│   │  ✓ Website    │ │  + Mailchimp  │ │  + Stripe     │         │
│   │  ✓ Domain     │ │  + Instagram  │ │  + Shopify    │         │
│   │  ✓ 2 emails   │ │  + Maps       │ │  + Zapier     │         │
│   │  ✓ Analytics  │ │  + Full stats │ │  + Revenue    │         │
│   │  ✓ Booking    │ │               │ │    tracking   │         │
│   │               │ │               │ │               │         │
│   │  [Get Started]│ │  [Get Started]│ │  [Get Started]│         │
│   └───────────────┘ └───────────────┘ └───────────────┘         │
│                                                                  │
│   ✓ First month FREE on all plans                               │
│   ✓ No payment until you approve your site                      │
│   ✓ Cancel anytime — you own everything                         │
│                                                                  │
│              [Book Your Free Discovery Call]                     │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                          FAQ                                     │
│                                                                  │
│   ▸ What if I don't like my website?                            │
│     You don't pay until you approve it. If it's not right,      │
│     we'll revise it until it is — or walk away, no charge.      │
│                                                                  │
│   ▸ What if I need changes later?                               │
│     Just tell us what you want in plain words. "Change the      │
│     phone number" or "Add a new service" — we handle it.        │
│     Standard changes are included in your subscription.          │
│                                                                  │
│   ▸ Do I own my website?                                        │
│     Yes, 100%. Download your source code anytime. If you        │
│     ever want to leave, take everything with you.               │
│                                                                  │
│   ▸ Can I connect my booking system / email list / etc?         │
│     Yes! We support Calendly, Mailchimp, Stripe, Instagram,     │
│     Google Analytics, and more. We set them up for you.         │
│                                                                  │
│   ▸ What's NOT included?                                        │
│     Domain registration (~€10-15/year, you pay directly).       │
│     Major redesigns or new custom features are quoted           │
│     separately (€50-200 depending on scope).                    │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                    SOCIAL PROOF                                  │
│                                                                  │
│   (After pilot client - add testimonial + case study)           │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                    FINAL CTA                                     │
│                                                                  │
│         Ready to get your professional website?                  │
│                                                                  │
│         [Book Your Free 15-Minute Discovery Call]               │
│                                                                  │
│         No commitment. No payment required.                      │
│         Let's talk about your business.                          │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                       FOOTER                                     │
│                                                                  │
│   Flowstarter                                                    │
│   Professional websites for busy business owners.                │
│                                                                  │
│   [Contact] [Privacy] [Terms]                                   │
│                                                                  │
│   © 2026 Flowstarter                                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Payment Flow Detail

```
Discovery Call (FREE)
         │
         ▼
"We'll build your site and show you in quickly"
         │
         ▼
Site Built (no payment yet)
         │
         ▼
Client Reviews Site
         │
    ┌────┴────┐
    ▼         ▼
 APPROVE    REQUEST
    │       CHANGES
    │         │
    │         ▼
    │      We revise
    │         │
    │         ▼
    │      (repeat)
    │         │
    └────┬────┘
         │
         ▼
Client Approves Final Site
         │
         ▼
┌─────────────────────────────┐
│   STRIPE CHECKOUT           │
│                             │
│   Your Plan: [Starter/Pro/Business]
│   Setup Fee: €499           │
│   First Month: FREE         │
│                             │
│   Starting Month 2:         │
│   €19/39/79 per month       │
│                             │
│   [Pay & Launch My Site]    │
└─────────────────────────────┘
         │
         ▼
Payment Successful
         │
         ▼
┌─────────────────────────────┐
│   ACTIVATION                │
│                             │
│   • Site goes live          │
│   • Client gets dashboard   │
│   • Magic link email sent   │
│   • Subscription starts     │
│     (first charge Month 2)  │
└─────────────────────────────┘
```

### Key Landing Page Principles

1. **No payment until approval** - Reduces friction, builds trust
2. **Discovery call first** - Qualifies leads, personalizes service
3. **Clear pricing** - No hidden fees, transparent structure
4. **Urgency without pressure** - "Limited spots" but genuine
5. **Ownership emphasized** - Counter "lock-in" objection
6. **Social proof ready** - Placeholder for testimonials

### Calendly Setup for Discovery Calls

```
Event Type: "Website Discovery Call"
Duration: 15 minutes
Questions:
1. What's your business name?
2. What do you do? (brief description)
3. Do you have a current website?
4. What's your timeline?

Confirmation Email:
"Thanks for booking! Before our call:
- Think about what you want visitors to do on your site
- Have examples of sites you like (optional)
- We'll show you relevant examples on the call

See you soon!
— Darius"
```

---

## Priority 7: Client Activation Flow

### The Problem
After client pays and we build their site, how do they access it?

### Activation Flow

```
Client Pays (Stripe)
       │
       ▼
┌──────────────────────────────────────────┐
│  1. Team Builds Site                     │
│  • Using internal wizard + customization │
│  • Site deployed to Cloudflare           │
│  • Domain configured                     │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  2. Create Client Account                │
│  • Auto-create account in Clerk          │
│  • Link to project in Supabase           │
│  • Generate activation token             │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  3. Send Activation Email                │
│  • "Your website is ready!"              │
│  • Magic link (passwordless login)       │
│  • Link to: /activate?token=xxx          │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  4. Client Clicks Link                   │
│  • Logs them in automatically            │
│  • Shows their site dashboard            │
│  • Quick tour of features                │
└──────────────────────────────────────────┘
```

### Activation Email Template

```
Subject: 🎉 Your website is live!

Hi [Name],

Great news — your website is ready!

🌐 Your site: https://[domain].com
📊 Your dashboard: [Magic Link Button]

Click the button above to access your dashboard where you can:
• Request changes (just describe what you want!)
• View your site analytics
• Download your site files anytime

The link expires in 7 days. After that, you can always 
log in at flowstarter.app with this email.

Questions? Just reply to this email.

— Darius & Dorin
Flowstarter Team
```

### Technical Implementation

```typescript
// 1. After site is ready, trigger activation
async function activateClient(projectId: string, clientEmail: string) {
  // Create Clerk user (or get existing)
  const user = await clerk.users.create({
    emailAddresses: [clientEmail],
    skipPasswordRequirement: true  // Passwordless
  });
  
  // Link project to user
  await supabase.from('projects').update({
    clerk_user_id: user.id,
    status: 'active'
  }).eq('id', projectId);
  
  // Generate magic link
  const magicLink = await clerk.signInTokens.create({
    userId: user.id,
    expiresInSeconds: 7 * 24 * 60 * 60  // 7 days
  });
  
  // Send email
  await sendActivationEmail({
    to: clientEmail,
    magicLink: magicLink.url,
    siteDomain: project.domain,
    clientName: project.clientName
  });
}
```

### Subscription Activation (Stripe)

```
Payment Flow:
1. Client pays EUR 499 setup via Stripe checkout
2. Webhook creates project record with status='paid'
3. Team builds site (manual trigger)
4. When ready, team clicks "Activate Client"
5. System sends activation email
6. Monthly EUR 39 subscription starts on activation date
```

### Dashboard Access Levels

| User Type | Can Access |
|-----------|------------|
| **Team (Darius/Dorin)** | All projects, internal wizard, admin |
| **Client** | Only their project(s), chat, export |

### Login Options for Clients

1. **Magic Link** (recommended) - Sent via email, no password
2. **Google OAuth** - If they prefer
3. **Password** - Can set one later if they want

---

## Development Phases

### Phase 1: Foundation (Feb - Mar 2026)
- [ ] **P2:** Hide public wizard → internal-only (feature flag)
- [ ] **P1:** Build customization engine core
- [ ] **P1:** Implement template schema system
- [ ] **P1:** Create execution plan format
- [ ] **P1:** Build safe mutation layer
- [ ] **P5:** Create concierge landing page

### Phase 2: Core Engine (Mar - Apr 2026)
- [ ] **P1:** Complete customization engine (all standard requests work)
- [ ] **P3:** Build publish pipeline (Cloudflare Direct Upload)
- [ ] **P3:** S3/R2 snapshot backups
- [ ] **P1:** Implement preview system
- [ ] **P1:** Add rollback capability
- [ ] **Analytics:** GA4 backend + caching layer
- [ ] **Analytics:** Dashboard UI (3 cards, trends, top pages)
- [ ] **Analytics:** Leads system (contact form → Supabase → notifications)
- [ ] Internal testing with real templates

### Phase 3: Pilot Ready (Apr - May 2026)
- [ ] Polish 3 base templates (AI-friendly structure)
- [ ] End-to-end flow testing
- [ ] Human escalation system
- [ ] **P4:** Manual provisioning checklist
- [ ] **Analytics:** Test with real GA4 data
- [ ] **Analytics:** Handle empty states (new site, no data yet)
- [ ] **🎯 LAUNCH PILOT CLIENT** ⭐

### Phase 4: Scale (May - Aug 2026)
- [ ] Onboard 10-20 concierge clients
- [ ] Collect patterns for wizard automation
- [ ] **P4:** Automate provisioning (DNS, email, storage)
- [ ] **P6:** Build client-facing post-delivery interface
- [ ] Add billing/subscriptions (Stripe)

### Phase 5: Self-Service (Sep 2026+)
- [ ] Launch public wizard (informed by 50-100+ client patterns)
- [ ] Public template library
- [ ] Self-service customization UI
- [ ] Scale to 100+ clients

---

## Immediate Next Steps (This Week)

### Day 1-2: Hide Wizard (P2)
```bash
# Option A: Feature flag
INTERNAL_MODE=true

# Option B: Move routes
/dashboard/new → /internal/new
# Add auth check for team members only
```

### Day 3-4: Template Schema (P1)
```typescript
// Define for service-professional template
// File: templates/service-professional/schema.json
{
  "id": "service-professional",
  "sections": ["hero", "services", "testimonials", "contact"],
  "editableFields": [...],
  "variants": [...]
}
```

### Day 5-7: Customization Engine Stub (P1)
```typescript
// 1. Request parser
parseRequest("Change headline to X") → { type: 'update_text', target: 'hero.headline', value: 'X' }

// 2. Plan generator  
generatePlan(parsedRequest, templateSchema) → ExecutionPlan

// 3. Executor
execute(plan) → Result

// 4. Validator
validate(result, templateSchema) → { valid: true } | { valid: false, errors: [...] }
```

### Day 7: First Real Test
```
Input: "Change the hero headline to 'Transform Your Life Today'"
Expected: Hero section updated, preview shows new headline
Success: Works without breaking anything
```

---

## Success Metrics

| Metric | Target (Pilot) | Target (Scale) |
|--------|----------------|----------------|
| Customization success rate | 90%+ first try | 98%+ |
| Time to first site | < 1 week | < 3 days |
| Client satisfaction | 9+ NPS | 8+ NPS |
| Human escalation rate | < 30% | < 10% |
| Monthly recurring clients | 1 | 50+ |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| AI generates broken code | Template-first + schema validation |
| Client requests exceed AI capability | Human escalation → add-on quote |
| Scale too fast before engine ready | Hard limit on client count |
| Templates too rigid | Start with 5 flexible bases, add variants |
| Complex request looks simple | Manual classification initially, automate later |

---

## What Pricing Changes for Implementation

### Nothing in Priority 1 (Engine Core) Changes
The customization engine works the same — pricing just determines which requests are included vs quoted.

### Add Eventually (Not Blocking for Pilot):

| Feature | When | How |
|---------|------|-----|
| Complexity classifier | Phase 4+ | Engine detects standard vs complex |
| Add-on tracking | Phase 4+ | Client, request type, quote, status |
| Quote generation | Phase 4+ | Can be WhatsApp message initially |

### For Pilot Client:
All complexity classification and quoting happens in **Darius's head**, not in the system. Automate later.

---

## Pilot Focus: Standard Tier Only

**For the pilot client (May 2026), we focus exclusively on Standard tier:**

| What | Standard Only |
|------|---------------|
| Setup | €499 |
| Monthly | €39/mo (locked in forever) |
| Pages | 3-5 |
| Emails | 2 |
| Integrations | GA4, Contact Form, WhatsApp, Calendly |
| Dashboard | Visitors, Page Views, Leads, Top Pages |

**Why:**
- Simpler scope = faster to build
- Lower complexity = fewer bugs
- Validates core engine before adding Pro/Business features
- All Pro/Business features are **planned but not built** until we have 10+ Standard clients

**What we defer:**
- Mailchimp integration (Pro)
- Instagram feed (Pro)
- Google Maps (Pro)
- Advanced analytics (Pro)
- E-commerce/Stripe (Business)
- Course platforms (Business)
- Zapier (Business)

**These are documented and ready to add in Phase 4 (May-Aug 2026).**

---

*Document created: 2026-02-23*
*Last updated: 2026-02-23*
*Owner: Darius Popescu*
