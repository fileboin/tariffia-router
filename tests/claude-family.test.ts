import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { classifyClaudeFamily, isClaudeModel, resolveClaudeRouting } from '../src/core/claude-family.js';

describe('claude-family classifier (pure)', () => {
  test('recognizes Claude-family ids generically', () => {
    assert.equal(classifyClaudeFamily('claude-sonnet-5-5'), 'sonnet');
    assert.equal(classifyClaudeFamily('claude-opus-4-1-20250805'), 'opus');
    assert.equal(classifyClaudeFamily('claude-haiku-4-5'), 'haiku');
    // versioned / arbitrary suffixes work without a fixed list
    assert.equal(classifyClaudeFamily('claude-sonnet-99-99'), 'sonnet');
    assert.equal(classifyClaudeFamily('claude-3-5-sonnet-20241022'), 'sonnet');
  });

  test('extracts opus/sonnet/haiku when clearly present', () => {
    assert.equal(classifyClaudeFamily('claude-opus-x'), 'opus');
    assert.equal(classifyClaudeFamily('claude-sonnet-x'), 'sonnet');
    assert.equal(classifyClaudeFamily('claude-haiku-x'), 'haiku');
  });

  test('arbitrary future claude-* maps to default, never a guessed tier', () => {
    assert.equal(classifyClaudeFamily('claude-nova-9'), 'default');
    assert.equal(classifyClaudeFamily('claude-'), 'default');
    assert.equal(classifyClaudeFamily('claude'), 'default');
    // a planning-style alias containing opus is NOT an opus tier
    assert.equal(classifyClaudeFamily('claude-opusplan'), 'default');
  });

  test('non-Claude models return null (pass-through)', () => {
    for (const m of ['mesh/free', 'xai/grok-4.3', 'gpt-4o', 'grok-4.3', 'ollama/llama3.2', '']) {
      assert.equal(classifyClaudeFamily(m), null, `${m} must not be classified as Claude`);
    }
    assert.equal(classifyClaudeFamily(undefined), null);
    assert.equal(classifyClaudeFamily(null), null);
  });

  test('isClaudeModel is a cheap prefix check', () => {
    assert.equal(isClaudeModel('claude-sonnet-5-5'), true);
    assert.equal(isClaudeModel('Claude-Opus'), true);
    assert.equal(isClaudeModel('gpt-4o'), false);
  });
});

describe('resolveClaudeRouting (policy)', () => {
  test('default policy is auto: no mesh, no pin', () => {
    const r = resolveClaudeRouting('claude-sonnet-5-5');
    assert.deepEqual(r, { family: 'sonnet' });
  });

  test('a family can map to a profile', () => {
    const r = resolveClaudeRouting('claude-opus-4-1', { opus: 'best', sonnet: 'balanced' });
    assert.deepEqual(r, { family: 'opus', mesh: 'best' });
  });

  test('a family can map to an explicit provider/model pin', () => {
    const r = resolveClaudeRouting('claude-haiku-4-5', { haiku: { pin: 'xai/grok-4.3' } });
    assert.deepEqual(r, { family: 'haiku', pin: 'xai/grok-4.3' });
  });

  test('an unknown/future claude id uses the default target', () => {
    const r = resolveClaudeRouting('claude-nova-9', { default: 'balanced' });
    assert.deepEqual(r, { family: 'default', mesh: 'balanced' });
  });

  test('non-Claude ids resolve to null', () => {
    assert.equal(resolveClaudeRouting('gpt-4o', { sonnet: 'balanced' }), null);
  });

  test('a malformed target degrades to auto (no guess)', () => {
    const r = resolveClaudeRouting('claude-sonnet-5-5', { sonnet: { pin: '' } });
    assert.deepEqual(r, { family: 'sonnet' });
  });
});
