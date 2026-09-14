# The operator editor

> Building whole features on a client's site from the Flowstarter editor, and
> shipping them through the same gates as every other build.

## The rule, first

Darius's directive was two halves of one sentence:

> we should have the possibility to also build entire features from the editor,
> while users should just have the possibility of small changes with escalation
> to us for more

The second half already existed and works: the client editor offers Words and
Pictures, `editor-policy.ts` refuses anything structural server-side, credits
are counted, and "Bigger changes" escalates into a quoted change request. That
is the right shape for a client and it stays exactly as it is.

The first half is what this document is about. It rests on one rule:

**The operator's session may do anything a coding agent can do. The gates still
decide what ships.**

There is no allow-list of things an operator may build. A whole new page, a
section that does not exist, a third-party integration — all fine, all normal.
What is not negotiable is that none of it reaches a client until
`OPERATOR_EDIT_BUILD` has compiled it and run every output gate over the bytes
that would be deployed.

## What runs where

```
 flowstarter-main (the app slot, network_mode: host)
   │  admin/dashboard/projects/[id] → Editor tab
   │  POST /api/admin/projects/[id]/editor        (open + hand over)
   │  POST /api/admin/projects/[id]/editor/ship   (commit + enqueue)
   │
   ├── 127.0.0.1:3773  /__router/*  ─────────────┐  control plane
   │                                              │  (bearer secret,
   │                                              │   refuses forwarded)
   ▼                                              ▼
 Supabase                                 flowstarter-editor (one container)
   operator_editor_sessions                 router/supervisor :3773
   flowstarter_agent_jobs                     ├── editor process, slug A
   site_versions                              │     cwd /workspaces/A
                                              └── editor process, slug B
   ▲                                                cwd /workspaces/B
   │                                              (spawned on demand,
   │                                               idle-stopped)
   │                                                     ▲
 build-worker (Hetzner)                                  │ browser, through
   claims OPERATOR_EDIT_BUILD                            │ Caddy on the
   materialises the session manifest                     │ tenant vhost:
   runs every gate                                       │ <slug>.<domain>
   commits, saves a version, publishes ──► deploy-agent  │ /editor/*
```

Three processes, three jobs, and none of them reaches into another's storage:

- **flowstarter-main** owns the session row and decides who may open and ship.
- **the editor container** owns the worktree on disk. It never reads our
  database; it is handed a manifest and hands one back.
- **the build worker** owns publication. It never reads the editor host's
  disk; it reads the manifest off the session row.

That last one is deliberate. A build that can only be reproduced from a
filesystem somebody has to go and look at is not reproducible, and the editor
idle-stops and reaps worktrees.

## The flow, step by step

### 1. Open

Admin project page → **Editor** tab → **Open in editor**.

`POST /api/admin/projects/[id]/editor`:

1. `requireTeamAuth()`. Nobody outside the team gets any of this.
2. The project must be `HUMAN_QA` or `LIVE_SUBSCRIPTION`. Before the deposit
   build has produced a site there is nothing to open.
3. A session row is written, status `opening`, recording the operator, and
   `base_version` — the workspace's newest `site_versions.version`. **The row
   is written before the editor host is asked to do anything**: a host call
   that fails then leaves a row saying so, which an operator can see and close.
   The other order leaves a worktree on a box nothing in the database knows
   about.
4. The workspace's published manifest is read (`loadWorkspaceSite`, the same
   loader the client's own editor uses) and sent to the editor host, which
   wipes `/workspaces/<slug>`, writes the files, drops in a
   `.claude/settings.json` carrying the agent's deny rules, and makes an
   initial git commit. **This is a copy.** Nothing the operator types touches
   `/var/www/sites` or the client's manifest.
5. A one-minute Clerk sign-in ticket is minted and appended to
   `https://<slug>.<domain>/editor/`. The browser opens it in a new tab; the
   URL is never rendered into the page, because a ticket in the DOM is a
   ticket in a screenshot.

**One open session per workspace**, enforced by a partial unique index. A
second operator pressing Open joins the first one's session rather than cutting
a second worktree — two people working against each other's stale base is how
one of them silently loses their work.

#### Why the hand-over does not use `/api/auth/transfer-token`

That route's job is to vet a URL a browser proposed, and its answer for
`{slug}.{platformDomain}` is an emphatic no — twice over, by
`isNeverOperatorOwned` and by the absence of an allow-list entry. **That
refusal is correct and stays**: a page on a client's tenant-authored site
asking for a sign-in ticket is exactly the attack PR #133 exists for.

The admin route is not that caller. It has already run `requireTeamAuth`, it
has already decided which workspace, and it derives the destination itself from
`workspaces.slug` through `decideOperatorEditorDestination()`. Nothing a
browser sends reaches it — which is a stronger guarantee than an allow-list
entry would have been. Adding `{slug}.{domain}` to the shared allow-list would
have re-opened the tenant-site hole for every caller in order to serve one
caller that needs no list at all.

`code.{domain}` and `editor.{domain}` stay on the allow-list for a
root-mounted editor deployment that does not exist yet. The container's router
derives the workspace from the `Host`, so an editor at `code.{domain}` would
need a session-to-workspace map the router does not have. Until it does, the
tenant host is where the editor is.

### 2. Work

The editor is the forked T3 Code with a Claude Code backend. The operator has
a real filesystem, a terminal, and an agent.

**The file boundary is the build agent's, mirrored.**
`apps/flowstarter-editor/router/src/agent-boundary.ts` is an exact mirror of
`assertMutableAgentPath` in `packages/agentic-codegen/src/flowstarter/pi-sdk.ts`
— the same package-manager configuration surface (PR #136: `package.json`,
every lockfile, `.npmrc`, `.pnpmfile.*`, `pnpm-workspace.yaml`, `.yarnrc*`,
`bunfig.toml`, `.pnpm/`, `.yarn/`), plus `.git`, `node_modules`, `dist`,
`.astro`, `.github`, `.env*`, anything with `secret` or `credential` in the
name, and the build configs. The router writes those as deny rules into the
worktree's `.claude/settings.json` when it materialises it.

`router/test/agent-boundary.test.ts` is a parity guard: it reads `pi-sdk.ts`
off disk and fails if a name added upstream is missing here. Same pattern
`slug.ts` uses to stay in lock-step with the editor's own gate.

The agent's cwd is `/workspaces/<slug>` and it has no `additionalDirectories`,
so it cannot reach another client's worktree.

### 3. Ship

Admin project page → **Editor** tab → **Ship this**.

`POST /api/admin/projects/[id]/editor/ship`:

1. `assertSessionShippable()`:
   - the project is still in a state where a site can be published;
   - the session is `ready` (not already `shipping`, not closed);
   - **`base_version` still equals the site's current version.**
2. The editor host commits the worktree with
   `buildCommitMessage('OPERATOR_EDIT_BUILD', projectId)` — the message is
   decided here, by the build commit policy, and passed to the host, which
   writes what it is told and invents nothing. A subject the policy would
   refuse cannot appear in a client's history by way of a box nobody watches.
   This is the defect PR #146 paid for, in the one place it could recur.
3. The worktree is read back and stored on `operator_editor_sessions
   .result_manifest`. **Not in the job payload**: it is a whole site's worth of
   source, and the payload is a jsonb column every board query reads back.
4. One `OPERATOR_EDIT_BUILD` is queued (partial unique index: one live per
   workspace, covering `running` as well as `queued`) and the worker is nudged.
   The ledger row is the commitment; the nudge is only a nudge, and a queued
   job an operator can re-dispatch is far better than a failed ship.

#### The stale-base refusal

This is the one rule that costs an operator work, and it is the one that keeps
a client's own edits from disappearing:

> This session was cut from version 4 and the site is now at version 5: the
> client published a change of their own while you were working. Shipping now
> would delete it. Close this session and open a new one, which will start from
> their change.

There is no override. The alternative is a client's edit vanishing with no
record that it ever existed.

### 4. Build

`FullSiteBuildWorker.operatorEditBuild()` — CHANGE_REQUEST_BUILD's gates on
SITE_REBUILD's body.

| Phase | What it is |
| ----- | ---------- |
| Preparing a clean worktree | discard + create, as every kind does |
| Materializing the operator session | the session manifest, teaser-stripped, seed-placeholder rule applied, then the Cal.com and lead-capture integrations reconciled unconditionally |
| Checking the build | the gate of record: `pnpm install && pnpm build`, then the asset-binary, preview-teaser, cal-preview, placeholder-image and markup scanners over the exported output |
| Checking for placeholder copy | PR #110's rule |
| Checking for placeholder images | PR #110 |
| Checking what the site asks the browser to do | PR #134's markup policy |
| Checking for empty image elements | PR #165 |
| Checking the site against the acceptable-use policy | PR #158, and the one gate with no repair pass on any leg. A session is the one path that can add a whole new page to a live site, and the agent that wrote it took its instructions from a person rather than from our system prompt. The policy is a rule about the work we do, not about who typed it. |
| Committing the site | the commit policy again, this repository's side |
| Saving the new version of the site | `site_versions`, mirrored into `preview_manifest` |
| Publishing | the same publisher and the same deploy-agent path every build uses |

**No agent pass, and no repair pass.** On every other leg a failing gate gets
one repair pass, because the thing that wrote the site is an unattended agent
session and asking it to fix its own mess is cheaper than failing a build
somebody paid for. Here the thing that wrote the site is an operator, at a
keyboard, still sitting in the editor. An unattended pass over a feature they
deliberately built is how intent gets quietly undone — the repair prompt knows
what the gate wants and knows nothing about what the operator was doing. So a
gate that refuses stops the job, writes its plain words onto the session's
`last_error` and the activity timeline, and the operator fixes it and ships
again.

**No page budget.** The page-set rule exists to stop an agent inventing routes
nobody asked for out of a fixed brief. An operator session's whole purpose is
that it may add a page. Holding it to the client's original page count would
refuse exactly the work this path was built to do.

**Commit before save.** The order PR #146 paid for: the commit is a local
worktree nobody has seen and is cheap to lose; the version row is the half a
client is told about. A failure between them rolls the version back
(`discardOperatorEditVersion`, guarded on workspace + version number +
`created_by` naming this job + `published_at is null`), so a failed run never
leaves a finished, gate-clean build that nothing will ever publish.

### 5. What the client sees

`site_versions.created_by` is stamped `system:operator_edit_build:<jobId>` and
the summary reads *"Change made by the Flowstarter team"*. The client's own
version history prints, on the row:

> **Built by the Flowstarter team** · version 5

The rule is `lib/flowstarter/site-version-author.ts`, shared so the same words
appear anywhere a version is printed. It names **no individual** — a client
bought a service, not a person, and which of us was on shift is not theirs to
have. The operator's Clerk id is on the session row, where an operator can see
it.

## The session lifecycle

```
            open                host ok
   (none) ──────► opening ──────────────► ready ◄────────┐
                     │                      │            │
                     │ host failed          │ ship       │ a gate refused
                     ▼                      ▼            │
                  failed                shipping ────────┘
                  (closed)                  │
                                            │ every gate passed
                                            ▼
                                         shipped
   ready ── close ──► closed
```

A gate failure returns the session to `ready`, not to `failed`: the operator's
worktree is untouched and still theirs to fix, and a status reading `failed`
would say "this session is over" when the whole point is that it is not.

`shipping` is deliberately not closable — a build is running against its
manifest, and closing it would let a second Open cut a worktree from a version
the running build is about to replace.

## Tables and columns

`operator_editor_sessions` (migration `20260914180000`), service-role only —
the absence of any RLS policy is the deny. A member must not be able to
enumerate the times we opened a coding agent on their site.

| Column | Why it exists |
| ------ | ------------- |
| `operator_id` | who opened it. The first question anyone asks when a change nobody remembers shows up. |
| `base_version` | what it was cut from. The stale-base rule reads this. |
| `worktree_path`, `container_id`, `base_commit_sha` | what the host answered. This table records what happened; it does not dictate a layout the host must follow. |
| `result_manifest` | what was shipped. Kept after the fact, because a build that failed a gate has to be diagnosable from the bytes it was given, and the worktree may already be reaped. |
| `last_error` | the gate's own plain words, shown on the project page where the operator is already standing. |
| `build_job_id`, `shipped_version` | the link to the build and the version it went live in. |

`workspaces.editor_repo_url` / `editor_repo_ref` (migration `20260520000001`)
were added for a design where the host cloned a per-client git remote. That
repo never came to exist and the columns were read by no code. They stay — a
workspace whose source genuinely lives in a remote is still a thing we might
want — and their comment now says plainly that the normal case is `NULL`,
meaning the host materialises from the published manifest instead. The router
reads the session's worktree; it does not clone.

## Running it

See `deploy/hetzner-staging/README.md`, "The Flowstarter editor", for the
compose file, the env template and the stack script. In short:

```bash
sudo /opt/flowstarter/editor/editor-stack.sh up
sudo /opt/flowstarter/editor/editor-stack.sh check
sudo /opt/flowstarter/editor/editor-stack.sh health
```

`check` refuses to pass unless 3773 is loopback-only and a control secret of
at least 32 characters is set. `health` additionally proves the control plane
404s a request carrying `x-forwarded-host`, which is the assertion that a
browser on a client's site cannot reach it.

## What could still bite

- **A long session and a busy client.** The stale-base rule is a refusal, not
  a merge. On a workspace where the client edits often, an operator should
  expect to re-open. A three-way merge would be the fix; a silent overwrite
  would not.
- **Worktree size.** The ship step caps at 3,000 files and the host caps the
  total bytes. A session that has managed to get `node_modules` or a `dist/`
  under the worktree will be refused with a message saying so, which is the
  right answer — those are not site source.
- **The router's session registry is in memory.** A container restart between
  Open and Ship means the ship call finds no session on the host. The database
  row is the record of truth; re-open, which re-materialises. Deliberately not
  persisted: a second, stale copy of the truth on the editor host is worse
  than re-doing the cheap half.
- **No pre-ship preview.** The operator sees their work in the editor's own
  dev server, not on a deployed URL, until the build publishes. A staging
  deploy per session is the obvious next step and is not built.
