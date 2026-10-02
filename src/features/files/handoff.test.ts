import { describe, expect, test } from 'bun:test';
import { createBitmapDocument } from '../document';
import { clearHandedOffDocument, handOffDocument, takeHandedOffDocument } from './handoff';

describe('handOffDocument / takeHandedOffDocument', () => {
  test('returns null when nothing has been handed off for an id', () => {
    expect(takeHandedOffDocument('never-opened')).toBeNull();
  });

  test('hands back the exact same document instance that was handed off', () => {
    const document = createBitmapDocument('doc-1', 8, 8);
    handOffDocument(document);
    expect(takeHandedOffDocument('doc-1')).toBe(document);
  });

  test('is one-shot: a second take for the same id finds nothing', () => {
    const document = createBitmapDocument('doc-2', 8, 8);
    handOffDocument(document);
    takeHandedOffDocument('doc-2');
    expect(takeHandedOffDocument('doc-2')).toBeNull();
  });

  test('a second hand-off supersedes the first: only the newest id can be taken', () => {
    const a = createBitmapDocument('doc-a', 4, 4);
    const b = createBitmapDocument('doc-b', 4, 4);
    handOffDocument(a);
    handOffDocument(b);
    // The superseded one is gone, not just unreachable by this call — nothing pins it in memory.
    expect(takeHandedOffDocument('doc-a')).toBeNull();
    expect(takeHandedOffDocument('doc-b')).toBe(b);
  });

  test('clearHandedOffDocument drops a pending entry whose own navigation failed', () => {
    const document = createBitmapDocument('doc-3', 4, 4);
    handOffDocument(document);
    clearHandedOffDocument('doc-3');
    expect(takeHandedOffDocument('doc-3')).toBeNull();
  });

  test('clearHandedOffDocument is a no-op for an id that is not the pending one', () => {
    const document = createBitmapDocument('doc-4', 4, 4);
    handOffDocument(document);
    clearHandedOffDocument('some-other-id');
    expect(takeHandedOffDocument('doc-4')).toBe(document);
  });
});
