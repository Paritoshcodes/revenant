import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyWebhookSignature } from '../../src/webhooks/verify.js';

const SECRET = 'test_webhook_secret';

const sign = (body: string, secret = SECRET): string =>
  createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed raw body', () => {
    const body = Buffer.from('{"event":"payment.failed"}', 'utf8');
    const signature = sign(body.toString('utf8'));
    expect(verifyWebhookSignature(body, signature, SECRET)).toBe(true);
  });

  it('rejects a missing or empty signature header', () => {
    // A plain unsigned curl reached the endpoint during testing
    // (docs/API-BEHAVIOUR.md section 8); this must never pass.
    const body = Buffer.from('{"event":"payment.failed"}', 'utf8');
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, '', SECRET)).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const body = Buffer.from('{"event":"payment.failed"}', 'utf8');
    const signature = sign(body.toString('utf8'), 'wrong_secret');
    expect(verifyWebhookSignature(body, signature, SECRET)).toBe(false);
  });

  it('rejects a tampered body even against a validly-formatted signature', () => {
    const original = '{"event":"payment.failed","amount":100}';
    const tampered = '{"event":"payment.failed","amount":999999}';
    const signature = sign(original);
    expect(verifyWebhookSignature(Buffer.from(tampered, 'utf8'), signature, SECRET)).toBe(false);
  });

  it('does not throw on a signature of a different length, and rejects it', () => {
    // node:crypto's timingSafeEqual throws on mismatched buffer lengths;
    // an attacker's wrong-length guess must be rejected cleanly, not
    // crash the handler.
    const body = Buffer.from('{"event":"payment.failed"}', 'utf8');
    expect(() => verifyWebhookSignature(body, 'short', SECRET)).not.toThrow();
    expect(verifyWebhookSignature(body, 'short', SECRET)).toBe(false);
  });

  it('is sensitive to a single differing character in an equal-length signature', () => {
    const body = Buffer.from('{"event":"payment.failed"}', 'utf8');
    const valid = sign(body.toString('utf8'));
    const flippedLastChar = valid.endsWith('a') ? 'b' : 'a';
    const flipped = valid.slice(0, -1) + flippedLastChar;
    expect(verifyWebhookSignature(body, flipped, SECRET)).toBe(false);
  });

  it('never parses the body: raw bytes in, boolean out, no JSON dependency', () => {
    // Not literally testable as an absence, but a non-JSON body must
    // still verify correctly against its own signature, proving no
    // parse/re-serialise step sits in between.
    const body = Buffer.from('not json at all', 'utf8');
    const signature = sign(body.toString('utf8'));
    expect(verifyWebhookSignature(body, signature, SECRET)).toBe(true);
  });
});
