import { describe, expect, it } from 'vitest';
import { statCellTone, type StatCellKey } from '../StatsStrip';

describe('statCellTone', () => {
  it('reads money as ok', () => {
    expect(statCellTone('revenue')).toBe('ok');
  });

  it('reads AI spend as warn', () => {
    expect(statCellTone('ai')).toBe('warn');
  });

  it('reads the pipeline-shaped counts as accent then teal, in stage order', () => {
    expect(statCellTone('projects')).toBe('accent');
    expect(statCellTone('live')).toBe('teal');
  });

  it('reads clients as pink, the audience-and-reach tone', () => {
    expect(statCellTone('clients')).toBe('pink');
  });

  it('has a tone for every stat cell key', () => {
    const keys: StatCellKey[] = [
      'projects',
      'live',
      'clients',
      'revenue',
      'ai',
    ];
    for (const key of keys) {
      expect(statCellTone(key)).toBeTruthy();
    }
  });
});
