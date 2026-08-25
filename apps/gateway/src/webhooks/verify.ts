/**
 * Razorpay webhook signature verification.
 *
 * docs/API-BEHAVIOUR.md section 8: HMAC-SHA256 hex digest over the RAW
 * request body, timing-safe compared against x-razorpay-signature. A
 * plain unsigned curl reached the endpoint during testing, so this check
 * is the only thing standing between an attacker and forged payment
 * events — it must run, and pass, before anything else touches the body.
 * Never parse or re-serialise the body first: re-encoding JSON can change
 * whitespace or key order and silently break the hash.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const verifyWebhookSignature = (
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean => {
  if (signatureHeader === undefined || signatureHeader === '') return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(signatureHeader, 'utf8');

  // timingSafeEqual throws on a length mismatch rather than returning
  // false, so a wrong-length guess must be rejected before reaching it.
  if (expectedBuffer.length !== providedBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, providedBuffer);
};
