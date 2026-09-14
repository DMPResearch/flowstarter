# Archived planning docs

Docs in this folder predate or were superseded by the **concierge pivot** (started 2026-02-23, hosting + editor architecture finalized 2026-05-06).

| Doc | Why archived |
|-----|-------------|
| `MIGRATION_PLAN.md` | Migration to Claude Code + Daytona orchestration. Daytona is now dropped for client-facing in favor of per-client Docker on Hetzner. |
| `editor-agent-plan.md` | Pre-pivot AutoGen multi-agent system. Replaced by stripped T3 fork + Claude API. |
| `flowstarter-engine-v1-audit.md` | Pre-pivot audit of the v1 engine. Architecture has changed materially. |
| `IMPLEMENTATION_PLAN.md` | Heavy assumptions on Cloudflare Pages hosting + Daytona sandboxes. Hosting target is now Hetzner; sandboxes are per-client Docker. |
| `CLIENT_EDITOR_PLAN.md` | Detailed client-editor flow assuming Cloudflare Pages publish + `{slug}.pages.dev` subdomains. Replaced by Hetzner deploy-agent + `{slug}.preview.flowstarter.app` topology. |
| `AUDIT.md` | Snapshot codebase audit dated 2026-03-02. References pre-pivot file paths (e.g. `lib/editor/daytona/client.ts`) that no longer exist. Useful as historical context only. |
| `improvement-plan.md` | Scored a branch called `feature/concierge-pivot` that no longer exists as the shipped product; assumes Convex codegen (never adopted) and audits Daytona sandbox isolation (dropped for previews by PR #132). Archived 2026-09-14; see `docs/next-steps.md` for current open items. |

**Canonical docs** for the current model:
- `docs/CONCIERGE_PIVOT_PLAN.md` — strategic roadmap.
- `docs/CONCIERGE_COMMERCE_MODEL.md` — commerce provider routing.
- `~/.claude/plans/merry-jingling-bengio.md` — executable Slice 1–4 plan with Hetzner + Docker architecture.

Anything in this folder may still contain useful design ideas, but specific tech choices (Cloudflare Pages, Daytona) are no longer authoritative.
