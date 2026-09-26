import { expect, test } from 'bun:test';
import { createDocumentId } from './documentId';

const VERSION_4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('ids are version 4 UUIDs', () => {
  for (let i = 0; i < 1000; i++) expect(createDocumentId()).toMatch(VERSION_4);
});

test('ids are unique', () => {
  const ids = new Set(Array.from({ length: 10_000 }, createDocumentId));
  expect(ids.size).toBe(10_000);
});

test('ids need no secure context, where only getRandomValues exists', () => {
  const secure = globalThis.crypto;
  const insecure = { getRandomValues: secure.getRandomValues.bind(secure) };
  Object.defineProperty(globalThis, 'crypto', {
    value: insecure,
    configurable: true,
    writable: true,
  });
  try {
    expect(createDocumentId()).toMatch(VERSION_4);
  } finally {
    Object.defineProperty(globalThis, 'crypto', {
      value: secure,
      configurable: true,
      writable: true,
    });
  }
});
