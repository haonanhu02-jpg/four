import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from '../apps/web/src/lib/uuid.ts';
import { sampleDocument, documentFromText } from '../packages/contracts/dist/index.js';

const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('item identifiers use native UUIDs in secure contexts', () => {
  assert.match(randomUUID(), v4);
});

test('private HTTP without crypto.randomUUID uses cryptographic random bytes', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const nativeCrypto = globalThis.crypto;
  let calls = 0;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues(array) {
        calls++;
        return nativeCrypto.getRandomValues(array);
      },
    },
  });
  try {
    const ids = new Set(Array.from({ length: 100 }, () => randomUUID()));
    assert.equal(calls, 100);
    assert.equal(ids.size, 100);
    for (const id of ids) assert.match(id, v4);
    const sample = sampleDocument('2026-11-12');
    const records = Object.values(sample.items).flat();
    assert.equal(records.length, 24);
    for (const record of records) assert.match(record.id, v4);
    const imported = documentFromText('first item\nsecond item', '2026-11-12');
    assert.equal(imported.items.daily.length, 2);
    for (const record of imported.items.daily) assert.match(record.id, v4);
  } finally {
    Object.defineProperty(globalThis, 'crypto', previous);
  }
});
