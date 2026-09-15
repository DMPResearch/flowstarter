/**
 * The operator identity, and the honest blank that stands in for it.
 *
 * The thing worth pinning here is not the happy path. It is that five of six
 * values is still "pending": a page that prints a company name, a
 * registration number and an address while omitting the VAT number reads as a
 * complete disclosure and is not one, and there is no ordering of these six in
 * which a partial answer is a legal statement.
 */
import { describe, expect, it } from 'vitest';
import {
  LEGAL_IDENTITY_ENV_VARS,
  OPERATOR_IDENTITY_PENDING_NOTICE,
  controllerIdentityLines,
  controllerSentence,
  governingLawSentence,
  legalDraftNoticeVisible,
  readOperatorIdentity,
} from '../company';

const FULL = {
  FLOWSTARTER_LEGAL_ENTITY_NAME: 'Flowstarter SRL',
  FLOWSTARTER_LEGAL_REGISTRATION_NUMBER: 'J12/3456/2026',
  FLOWSTARTER_LEGAL_VAT_NUMBER: 'RO12345678',
  FLOWSTARTER_LEGAL_ADDRESS: 'Str. Exemplu 1, Cluj-Napoca, Romania',
  FLOWSTARTER_LEGAL_JURISDICTION: 'Romania',
  FLOWSTARTER_LEGAL_COURT: 'the courts of Cluj-Napoca',
};

describe('readOperatorIdentity', () => {
  it('reads all six values when all six are set', () => {
    const state = readOperatorIdentity(FULL);
    expect(state.provided).toBe(true);
    if (!state.provided) throw new Error('unreachable');
    expect(state.identity.name).toBe('Flowstarter SRL');
    expect(state.identity.vatNumber).toBe('RO12345678');
    expect(state.identity.court).toBe('the courts of Cluj-Napoca');
  });

  it('is pending on an empty environment, and names every missing variable', () => {
    const state = readOperatorIdentity({});
    expect(state.provided).toBe(false);
    if (state.provided) throw new Error('unreachable');
    expect(state.missing).toEqual([...LEGAL_IDENTITY_ENV_VARS]);
  });

  it.each(LEGAL_IDENTITY_ENV_VARS)(
    'is pending when only %s is missing',
    (missing) => {
      const env: Record<string, string | undefined> = { ...FULL };
      delete env[missing];
      const state = readOperatorIdentity(env);
      expect(state.provided).toBe(false);
      if (state.provided) throw new Error('unreachable');
      expect(state.missing).toEqual([missing]);
    }
  );

  it('treats whitespace as absent, so a stray space is not an identity', () => {
    const state = readOperatorIdentity({
      ...FULL,
      FLOWSTARTER_LEGAL_VAT_NUMBER: '   ',
    });
    expect(state.provided).toBe(false);
  });

  it('trims the values it does read', () => {
    const state = readOperatorIdentity({
      ...FULL,
      FLOWSTARTER_LEGAL_ENTITY_NAME: '  Flowstarter SRL  ',
    });
    if (!state.provided) throw new Error('unreachable');
    expect(state.identity.name).toBe('Flowstarter SRL');
  });
});

describe('legalDraftNoticeVisible', () => {
  it('shows the notice while the identity is pending', () => {
    expect(legalDraftNoticeVisible(readOperatorIdentity({}))).toBe(true);
  });

  it('hides it once every value is set', () => {
    expect(legalDraftNoticeVisible(readOperatorIdentity(FULL))).toBe(false);
  });
});

describe('governingLawSentence', () => {
  it('names neither a country nor a court while the identity is pending', () => {
    const sentence = governingLawSentence(readOperatorIdentity({}));
    expect(sentence).not.toMatch(/Romania/i);
    expect(sentence).not.toMatch(/Cluj/i);
    expect(sentence).toMatch(/not yet incorporated/i);
  });

  it('names the jurisdiction, entity and court from the environment', () => {
    const sentence = governingLawSentence(readOperatorIdentity(FULL));
    expect(sentence).toContain('Romania');
    expect(sentence).toContain('Flowstarter SRL');
    expect(sentence).toContain('the courts of Cluj-Napoca');
  });

  it('has no em dash, in either state', () => {
    expect(governingLawSentence(readOperatorIdentity({}))).not.toContain('—');
    expect(governingLawSentence(readOperatorIdentity(FULL))).not.toContain('—');
  });
});

describe('controller identity', () => {
  it('lists nothing while pending, because there is nothing true to list', () => {
    expect(controllerIdentityLines(readOperatorIdentity({}))).toEqual([]);
  });

  it('lists name, registration, VAT and address once provided', () => {
    const lines = controllerIdentityLines(readOperatorIdentity(FULL));
    expect(lines).toHaveLength(4);
    expect(lines.join(' ')).toContain('J12/3456/2026');
    expect(lines.join(' ')).toContain('RO12345678');
  });

  it('says the identity is pending, in those words, while it is', () => {
    const sentence = controllerSentence(readOperatorIdentity({}));
    expect(sentence).toContain(OPERATOR_IDENTITY_PENDING_NOTICE);
    expect(sentence).not.toMatch(/registered in the European Union/i);
  });

  it('names the entity once provided', () => {
    expect(controllerSentence(readOperatorIdentity(FULL))).toContain(
      'Flowstarter SRL'
    );
  });
});
