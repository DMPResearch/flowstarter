import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assignSitePorts,
  derivePort,
  DEFAULT_SITE_PORT_RANGE,
  emptyPortState,
  loadPortState,
  parsePortRange,
  parsePortState,
  releaseSitePorts,
  savePortState,
  serializePortState,
  type PortRange,
} from './site-ports';

describe('parsePortRange', () => {
  test('parses a valid "min-max" string', () => {
    expect(parsePortRange('20000-29999')).toEqual({ min: 20000, max: 29999 });
    expect(parsePortRange('1000-1001')).toEqual({ min: 1000, max: 1001 });
  });

  test('falls back to the default for a missing value', () => {
    expect(parsePortRange(undefined)).toEqual({ min: 20000, max: 29999 });
    expect(parsePortRange(null)).toEqual({ min: 20000, max: 29999 });
    expect(parsePortRange('')).toEqual({ min: 20000, max: 29999 });
  });

  test('falls back to the default for garbage rather than crashing the agent', () => {
    for (const bad of [
      'not-a-range',
      '100',
      '100-50',
      '0-100',
      '60000-70000',
      '100-100',
    ]) {
      expect(parsePortRange(bad)).toEqual(
        parsePortRange(DEFAULT_SITE_PORT_RANGE),
      );
    }
  });
});

describe('derivePort', () => {
  const range: PortRange = { min: 20000, max: 29999 };

  test('is deterministic: the same slug and range always produce the same port', () => {
    const first = derivePort('acme-widgets', range);
    const second = derivePort('acme-widgets', range);
    expect(first).toBe(second);
  });

  test('stays inside the given range for a wide variety of slugs', () => {
    const slugs = [
      'a',
      'acme',
      'darius-mihai-popescu-enxxz0',
      'z'.repeat(63),
      'has-many-hyphens-in-it',
      '123-numeric-start',
    ];
    for (const slug of slugs) {
      const port = derivePort(slug, range);
      expect(port).toBeGreaterThanOrEqual(range.min);
      expect(port).toBeLessThanOrEqual(range.max);
    }
  });

  test('a different salt gives a candidate that is usually a different port, still in range', () => {
    // Not a strict guarantee for every input, but the two slots need to
    // usually land on different candidates before collision handling ever
    // has to walk forward — otherwise every fresh slug would immediately
    // hit the collision path.
    let differed = 0;
    for (let i = 0; i < 20; i++) {
      const slug = `slug-${i}`;
      const a = derivePort(slug, range, 'a');
      const b = derivePort(slug, range, 'b');
      expect(a).toBeGreaterThanOrEqual(range.min);
      expect(b).toBeLessThanOrEqual(range.max);
      if (a !== b) differed++;
    }
    expect(differed).toBeGreaterThan(15);
  });

  test('respects a range as small as a single port', () => {
    const single: PortRange = { min: 5000, max: 5000 };
    expect(derivePort('anything', single)).toBe(5000);
    expect(derivePort('something-else', single)).toBe(5000);
  });
});

describe('assignSitePorts — collision safety', () => {
  test('a new slug gets two distinct ports, both inside the range', () => {
    const state = emptyPortState();
    const range: PortRange = { min: 20000, max: 29999 };
    const pair = assignSitePorts(state, 'acme', range);
    expect(pair.a).not.toBe(pair.b);
    for (const port of [pair.a, pair.b]) {
      expect(port).toBeGreaterThanOrEqual(range.min);
      expect(port).toBeLessThanOrEqual(range.max);
    }
    expect(state.sites['acme']).toEqual(pair);
  });

  test('is idempotent: a second call for the same slug returns the exact same pair', () => {
    const state = emptyPortState();
    const range: PortRange = { min: 20000, max: 29999 };
    const first = assignSitePorts(state, 'acme', range);
    const second = assignSitePorts(state, 'acme', range);
    expect(second).toEqual(first);
  });

  test('a slug keeps its port pair even if the range narrows around it afterward', () => {
    // "the slug keeps its port for its lifetime" — the whole point of
    // persisting the assignment rather than recomputing it every time.
    const state = emptyPortState();
    const wide: PortRange = { min: 20000, max: 29999 };
    const original = assignSitePorts(state, 'acme', wide);

    const narrow: PortRange = { min: 1, max: 4 };
    const again = assignSitePorts(state, 'acme', narrow);
    expect(again).toEqual(original);
  });

  test('two different slugs never share a port, even filling a tiny range exactly', () => {
    // A 10-port range holding 5 slugs' worth of pairs (2 ports each) — the
    // tightest case where collision handling has to do real work.
    const state = emptyPortState();
    const range: PortRange = { min: 20000, max: 20009 };
    const slugs = [
      'site-one',
      'site-two',
      'site-three',
      'site-four',
      'site-five',
    ];
    const pairs = slugs.map((slug) => assignSitePorts(state, slug, range));

    const allPorts = pairs.flatMap((p) => [p.a, p.b]);
    expect(new Set(allPorts).size).toBe(allPorts.length);
    for (const port of allPorts) {
      expect(port).toBeGreaterThanOrEqual(range.min);
      expect(port).toBeLessThanOrEqual(range.max);
    }
  });

  test('releasing a slug frees its ports for a later assignment to reuse', () => {
    const state = emptyPortState();
    const range: PortRange = { min: 20000, max: 20003 }; // exactly 2 pairs' worth
    assignSitePorts(state, 'first', range);
    assignSitePorts(state, 'second', range);
    // The range is full; a third slug has nowhere to go until one is freed.
    releaseSitePorts(state, 'first');
    expect(state.sites['first']).toBeUndefined();

    const third = assignSitePorts(state, 'third', range);
    for (const port of [third.a, third.b]) {
      expect(port).toBeGreaterThanOrEqual(range.min);
      expect(port).toBeLessThanOrEqual(range.max);
    }
    // Still exactly two live entries — "second" and the newly assigned
    // "third" — and none of "third"'s ports collide with "second"'s.
    expect(Object.keys(state.sites).sort()).toEqual(['second', 'third']);
    const secondPorts = [state.sites['second']?.a, state.sites['second']?.b];
    expect(secondPorts).not.toContain(third.a);
    expect(secondPorts).not.toContain(third.b);
  });
});

describe('port state — serialization and round trip', () => {
  test('serializePortState / parsePortState round-trips a state with multiple sites', () => {
    const state = {
      sites: { acme: { a: 20001, b: 20002 }, other: { a: 20501, b: 20777 } },
    };
    const roundTripped = parsePortState(serializePortState(state));
    expect(roundTripped).toEqual(state);
  });

  test('parsePortState tolerates a missing or corrupt file without throwing', () => {
    expect(parsePortState('')).toEqual(emptyPortState());
    expect(parsePortState('not json at all')).toEqual(emptyPortState());
    expect(parsePortState('{}')).toEqual(emptyPortState());
    expect(parsePortState('{"sites": "not an object"}')).toEqual(
      emptyPortState(),
    );
  });

  test('parsePortState drops an entry that is not a valid port pair rather than propagating it', () => {
    const raw = JSON.stringify({
      sites: {
        good: { a: 1, b: 2 },
        missingB: { a: 1 },
        notNumbers: { a: 'x', b: 'y' },
        null: null,
      },
    });
    expect(parsePortState(raw)).toEqual({ sites: { good: { a: 1, b: 2 } } });
  });

  test('loadPortState / savePortState round-trip through the real filesystem', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'site-ports-'));
    const path = join(dir, 'nested', '.ports.json');
    const state = { sites: { acme: { a: 20001, b: 20002 } } };

    await savePortState(path, state);
    const loaded = await loadPortState(path);
    expect(loaded).toEqual(state);
  });

  test('savePortState writes atomically: no leftover temp file survives a save', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'site-ports-'));
    const path = join(dir, '.ports.json');
    await savePortState(path, { sites: { acme: { a: 20001, b: 20002 } } });
    const entries = await readdir(dir);
    expect(entries).toEqual(['.ports.json']);
  });

  test('loadPortState returns an empty state, not a throw, when the file does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'site-ports-'));
    const loaded = await loadPortState(join(dir, 'does-not-exist.json'));
    expect(loaded).toEqual(emptyPortState());
  });
});
