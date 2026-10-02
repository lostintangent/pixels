import { describe, expect, test } from 'bun:test';
import { DOCUMENT_NAME_MAX_LENGTH, normalizeDocumentName } from './documentName';

describe('normalizeDocumentName', () => {
  test('trims the ends and keeps inner spacing readable', () => {
    expect(normalizeDocumentName('  Hero   sprite  ')).toBe('Hero sprite');
  });

  test('an empty or blank name keeps the old one', () => {
    expect(normalizeDocumentName('')).toBeNull();
    expect(normalizeDocumentName(' \t\n ')).toBeNull();
  });

  test('pasted line breaks and control characters become single spaces', () => {
    expect(normalizeDocumentName('Walk\ncycle\u0007 v2\u2028final')).toBe('Walk cycle v2 final');
  });

  test('caps the length in characters without splitting an emoji', () => {
    const long = `${'a'.repeat(DOCUMENT_NAME_MAX_LENGTH - 1)}🐙🐙`;
    const name = normalizeDocumentName(long)!;
    expect(Array.from(name)).toHaveLength(DOCUMENT_NAME_MAX_LENGTH);
    expect(name.endsWith('🐙')).toBe(true);
  });

  test('a cut that lands on a space leaves no trailing space', () => {
    expect(normalizeDocumentName(`${'a'.repeat(DOCUMENT_NAME_MAX_LENGTH - 1)} tail`)).toBe(
      'a'.repeat(DOCUMENT_NAME_MAX_LENGTH - 1),
    );
  });
});
