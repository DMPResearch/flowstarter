/**
 * Cost-aware, held-out evaluation.
 *
 * Accuracy is the wrong number for a guardrail. Missing one thing costs a
 * hundred times what over-reacting to another does, and a scorer that
 * averages them tells you nothing about whether you can ship. So every
 * mistake here has a name and a price, the prices live in the platform's
 * config file rather than in this module, and the release gate is a total
 * cost plus a hard zero on the mistake that is not tradeable.
 *
 * This module deliberately ships no corpus. Calibration examples and release
 * holdouts have to be separate artifacts with separately recorded authorship,
 * or a green score only measures how well we encoded our own examples — which
 * is what `DatasetProvenance` is a gate on.
 *
 * Dataset shape matches Ereno sigma's `tests/data/classifier_eval.json`:
 * `parity_groups` (one request in several languages, all of which must reach
 * the same verdict) plus `cases` (one prompt with an absolute expectation),
 * with a row-level `xfail` string for a verdict we know is wrong and want the
 * suite to hold us to. A set can move between the two platforms unchanged.
 */

/* ── dataset ──────────────────────────────────────────────────────────── */

/** Expectations are open: a platform names its own keys (label, action, …). */
export type Expectations = Record<string, unknown>;

export interface ParityGroup extends Expectations {
  id: string;
  /** language code -> the same request written in that language. */
  prompts: Record<string, string>;
  /** A verdict we know is wrong. Strict: fixing it must delete the marker. */
  xfail?: string;
}

export interface EvalCase extends Expectations {
  id: string;
  prompt: string;
  language?: string;
  xfail?: string;
}

export type HoldoutSource = 'independent_synthetic' | 'redacted_real_traffic';

/** Evidence that release numbers came from a genuinely held-out set. */
export interface DatasetProvenance {
  calibration_authors: string[];
  holdout_authors: string[];
  holdout_source: HoldoutSource;
  privacy_reviewed: boolean;
  built_at?: string;
}

export interface EvalDataset {
  _readme?: string[];
  version?: string;
  provenance: DatasetProvenance;
  parity_groups: ParityGroup[];
  cases: EvalCase[];
}

/** One prompt to run, with the row it came from. */
export interface EvalItem {
  /** Unique across the whole dataset: `group:lang` or the case id. */
  id: string;
  groupId: string | null;
  language: string;
  prompt: string;
  expectations: Expectations;
  xfail?: string;
}

/** Flatten a dataset into the prompts to actually run, parity groups expanded. */
export function expandDataset(dataset: EvalDataset): EvalItem[] {
  const items: EvalItem[] = [];
  const seen = new Set<string>();
  const push = (item: EvalItem) => {
    if (seen.has(item.id)) throw new Error(`duplicate eval row id: ${item.id}`);
    seen.add(item.id);
    items.push(item);
  };
  for (const group of dataset.parity_groups) {
    const { id, prompts, xfail, ...expectations } = group;
    const languages = Object.keys(prompts);
    if (languages.length < 2) {
      throw new Error(`parity group "${id}" has fewer than two languages`);
    }
    for (const language of languages) {
      push({
        id: `${id}:${language}`,
        groupId: id,
        language,
        prompt: prompts[language] as string,
        expectations,
        ...(xfail ? { xfail } : {}),
      });
    }
  }
  for (const row of dataset.cases) {
    const { id, prompt, language, xfail, ...expectations } = row;
    push({
      id,
      groupId: null,
      language: language ?? 'en',
      prompt,
      expectations,
      ...(xfail ? { xfail } : {}),
    });
  }
  return items;
}

/* ── scoring ──────────────────────────────────────────────────────────── */

export interface ScoredItem<L extends string = string, A extends string = string> {
  id: string;
  groupId: string | null;
  language: string;
  expectedLabel: L | null;
  expectedAction: A;
  actualLabel: L | null;
  actualAction: A;
  abstained: boolean;
  xfail?: string;
}

/**
 * What went wrong with one row, as counter names. The platform decides both
 * the names and their prices; this module only adds them up.
 *
 * Return an empty array for a row that is exactly right.
 */
export type CostModel<L extends string = string, A extends string = string> = (
  item: ScoredItem<L, A>,
) => readonly string[];

export type CostTable = Readonly<Record<string, number>>;

export interface EvaluationReport<L extends string = string, A extends string = string> {
  cases: number;
  abstentions: number;
  /** Fraction of rows where a tier produced a label. */
  coverage: number;
  /** Fraction of COVERED rows whose label was right. */
  accuracyOnCovered: number;
  /** Fraction of rows whose ACTION was right, abstentions included. */
  actionAccuracy: number;
  /** counter name -> how many rows fired it. */
  counters: Record<string, number>;
  weightedCost: number;
  /** Rows that fired at least one counter, for the failure message. */
  failures: Array<ScoredItem<L, A> & { fired: readonly string[] }>;
  /** Rows marked xfail that unexpectedly came out right. */
  unexpectedPasses: string[];
}

/**
 * Score a run. Rows carrying `xfail` are excluded from cost and counters but
 * reported when they pass, because a fixed row that still carries a marker is
 * a lie the next person will trust.
 */
export function scoreEvaluation<L extends string = string, A extends string = string>(
  items: readonly ScoredItem<L, A>[],
  costs: CostTable,
  model: CostModel<L, A>,
): EvaluationReport<L, A> {
  const counters: Record<string, number> = {};
  const failures: Array<ScoredItem<L, A> & { fired: readonly string[] }> = [];
  const unexpectedPasses: string[] = [];
  let weightedCost = 0;
  let abstentions = 0;
  let correctLabels = 0;
  let covered = 0;
  let correctActions = 0;
  let scored = 0;

  for (const item of items) {
    const fired = model(item);
    if (item.xfail) {
      if (fired.length === 0) unexpectedPasses.push(item.id);
      continue;
    }
    scored += 1;
    if (item.abstained) abstentions += 1;
    else {
      covered += 1;
      if (item.actualLabel === item.expectedLabel) correctLabels += 1;
    }
    if (item.actualAction === item.expectedAction) correctActions += 1;
    if (fired.length > 0) failures.push({ ...item, fired });
    for (const name of fired) {
      const price = costs[name];
      if (price === undefined) {
        throw new Error(`cost table has no entry for "${name}"`);
      }
      counters[name] = (counters[name] ?? 0) + 1;
      weightedCost += price;
    }
  }

  return {
    cases: scored,
    abstentions,
    coverage: scored === 0 ? 0 : covered / scored,
    accuracyOnCovered: covered === 0 ? 0 : correctLabels / covered,
    actionAccuracy: scored === 0 ? 0 : correctActions / scored,
    counters,
    weightedCost,
    failures,
    unexpectedPasses,
  };
}

export interface ParityViolation {
  groupId: string;
  language: string;
  expected: string;
  got: string;
}

export interface ParityOptions<A extends string = string> {
  referenceLanguage?: string;
  /**
   * The action a head falls back to when it is not confident enough to act.
   * Rows that landed on it are exempt in `contradiction` mode, because they
   * are not a claim about the request — they are a claim about our confidence.
   * Required for `contradiction` to mean anything; without it, only a literal
   * abstention is exempt and a guard-driven downgrade reads as a disagreement.
   */
  fallbackAction?: A;
  /**
   * `contradiction` (default) — two languages may not reach DIFFERENT
   * decisive actions for the same request. One abstaining, or falling back,
   * where another decided is allowed.
   *
   * `strict` — every language must reach the identical action and label.
   *
   * The default is the weaker property on purpose, and the reason is worth
   * having in the file rather than in a commit message. A confidence band is
   * a threshold on a continuous score, and the same request written in six
   * languages does not land on the same score: near the band, some languages
   * fall inside and some outside. Gating on `strict` would therefore gate on
   * where six translations happen to sit relative to a cosine, which is not a
   * property anybody wants to defend — the fix for a strict failure is almost
   * always to widen the band until the tier stops abstaining, which is
   * exactly backwards.
   *
   * What we do want, and what `contradiction` asserts, is that language never
   * changes WHAT we conclude, only whether we were confident enough to
   * conclude it. A brief that is refused in English and allowed in Romanian
   * is a real defect. One that is refused in English and sent to a human in
   * Romanian is the abstention machinery doing its job.
   *
   * Run `strict` as a reported number, not a gate: a rising strict count with
   * a flat contradiction count means the band is drifting away from one
   * language, which is worth knowing before it becomes a contradiction.
   */
  mode?: 'contradiction' | 'strict';
}

/**
 * The parity property, asserted directly rather than inferred from per-row
 * expectations. Language decides the language of the reply and nothing else.
 */
export function parityViolations<L extends string, A extends string>(
  items: readonly ScoredItem<L, A>[],
  options: ParityOptions<A> = {},
): ParityViolation[] {
  const referenceLanguage = options.referenceLanguage ?? 'en';
  const mode = options.mode ?? 'contradiction';
  const groups = new Map<string, ScoredItem<L, A>[]>();
  for (const item of items) {
    if (!item.groupId || item.xfail) continue;
    const bucket = groups.get(item.groupId) ?? [];
    bucket.push(item);
    groups.set(item.groupId, bucket);
  }
  const violations: ParityViolation[] = [];
  for (const [groupId, rows] of groups) {
    const reference =
      rows.find((row) => row.language === referenceLanguage) ?? (rows[0] as ScoredItem<L, A>);
    if (mode === 'strict') {
      const referenceVerdict = verdictOf(reference);
      for (const row of rows) {
        if (row === reference) continue;
        const verdict = verdictOf(row);
        if (verdict !== referenceVerdict) {
          violations.push({ groupId, language: row.language, expected: referenceVerdict, got: verdict });
        }
      }
      continue;
    }
    // Contradiction mode: collect the DECISIVE verdicts and require that all
    // of them agree. An abstaining row, or one that fell back, contributes
    // nothing to disagree with.
    const decisive = rows.filter(
      (row) =>
        !row.abstained &&
        row.actualLabel !== null &&
        (options.fallbackAction === undefined || row.actualAction !== options.fallbackAction),
    );
    const first = decisive[0];
    if (!first) continue;
    const baseline = decisive.find((row) => row.language === referenceLanguage) ?? first;
    const baselineAction = baseline.actualAction as string;
    for (const row of decisive) {
      if (row === baseline) continue;
      if ((row.actualAction as string) !== baselineAction) {
        violations.push({
          groupId,
          language: row.language,
          expected: `${baselineAction} (${baseline.language})`,
          got: verdictOf(row),
        });
      }
    }
  }
  return violations;
}

function verdictOf<L extends string, A extends string>(row: ScoredItem<L, A>): string {
  return `${row.actualAction}/${row.actualLabel ?? 'abstain'}`;
}

/* ── provenance gate ──────────────────────────────────────────────────── */

/**
 * Whether a holdout is eligible to support a release. This is a PROVENANCE
 * gate, not a quality threshold: the release owner still has to choose
 * acceptable error and risk limits for the lane.
 */
export function releaseReady(
  provenance: DatasetProvenance,
  options: { holdoutCases: number; minimumCases?: number },
): { ok: boolean; reasons: string[] } {
  const minimum = options.minimumCases ?? 120;
  const reasons: string[] = [];
  const calibration = new Set(provenance.calibration_authors);
  if (calibration.size === 0) reasons.push('no calibration authors recorded');
  if (provenance.holdout_authors.length === 0) reasons.push('no holdout authors recorded');
  if (provenance.holdout_authors.some((author) => calibration.has(author))) {
    reasons.push('calibration and holdout share an author');
  }
  if (provenance.holdout_source !== 'independent_synthetic' && !provenance.privacy_reviewed) {
    reasons.push('real traffic holdout without a recorded privacy review');
  }
  if (options.holdoutCases < minimum) {
    reasons.push(`holdout has ${options.holdoutCases} cases, needs ${minimum}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** A one-line summary safe to print in CI. Labels and numbers, never prompts. */
export function formatReport(report: EvaluationReport): string {
  const counters = Object.entries(report.counters)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name}=${count}`)
    .join(' ');
  return [
    `cases=${report.cases}`,
    `cost=${report.weightedCost}`,
    `coverage=${report.coverage.toFixed(3)}`,
    `accuracy_on_covered=${report.accuracyOnCovered.toFixed(3)}`,
    `action_accuracy=${report.actionAccuracy.toFixed(3)}`,
    counters,
  ]
    .filter(Boolean)
    .join(' ');
}
