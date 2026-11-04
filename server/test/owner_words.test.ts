import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerWords } from '../src/orchestrator.js';

test('the owner\'s exact words from the room\'s editor', () => {
  assert.deepEqual(ownerWords('Change the headline to exactly: "Duerme fresco"'), { headline: 'Duerme fresco' });
  assert.deepEqual(ownerWords('Change the body to exactly: "La almohada "mejor" calificada"'), { body: 'La almohada "mejor" calificada' });
  assert.equal(ownerWords('Change the headline to exactly: "  "'), undefined);
  assert.equal(ownerWords('Make the photo bigger'), undefined);
  assert.equal(ownerWords('Change the color to exactly: "red"'), undefined);
});
