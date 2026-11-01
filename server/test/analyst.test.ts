import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiMadeFile } from '../src/agents/analyst.js';

test('spots images an AI made by their file name', () => {
  assert.ok(aiMadeFile('https://cielohamacas.com.mx/cdn/shop/collections/ChatGPT_Image_23_jun_2026_02_43_50_p.m._49c9.png?v=1&width=2048'));
  assert.ok(aiMadeFile('https://x.com/wp-content/uploads/DALL%C2%B7E-2024-05-01-hammock.webp'));
  assert.ok(aiMadeFile('https://x.com/img/Gemini_Generated_Image_abc123.jpg'));
  assert.ok(!aiMadeFile('https://cielohamacas.com.mx/cdn/shop/collections/interior.jpg?v=1761605078&width=2048'));
  assert.ok(!aiMadeFile('https://x.com/img/leonardo-dicaprio-fan.jpg'));
});
