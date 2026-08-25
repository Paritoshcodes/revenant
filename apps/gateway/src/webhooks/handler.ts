/**
 * Razorpay webhook endpoint.
 *
 * docs/API-BEHAVIOUR.md section 8: respond within 5 seconds or Razorpay
 * retries, which is exactly how duplicate delivery happens by design. The
 * logic here is split so the HTTP response is decided and can be sent
 * BEFORE any database write is even attempted:
 *
 *   handleWebhookRequest  -- pure-ish: verifies the signature, decides the
 *                            response, and returns a `settled` promise for
 *                            the asynchronous recording/dispatch work.
 *   createWebhookRouter   -- Express wiring: sends the response, then lets
 *                            `settled` run to completion in the background.
 *
 * This also keeps handleWebhookRequest testable with a plain Buffer and a
 * fake db, with no Express request/response mocking needed.
 */
import express from 'express';
import type { Request, Response, Router } from 'express';

import { describeWebhookEvent } from './dispatch.js';
import { recordWebhookEvent } from './events-store.js';
import type { Queryable } from './events-store.js';
import { HANDLED_EVENT_TYPES } from './types.js';
import type { WebhookEnvelope } from './types.js';
import { verifyWebhookSignature } from './verify.js';

export const WEBHOOK_PATH = '/webhooks/razorpay';
const SIGNATURE_HEADER = 'x-razorpay-signature';
const EVENT_ID_HEADER = 'x-razorpay-event-id';

export interface WebhookHandlerDeps {
  readonly db: Queryable;
  readonly secret: string;
  readonly log?: (message: string) => void;
}

export interface WebhookRequestInput {
  readonly rawBody: Buffer;
  readonly signatureHeader: string | undefined;
  readonly eventIdHeader: string | undefined;
}

export interface WebhookResponse {
  readonly status: number;
  readonly body: { readonly ok: boolean; readonly error?: string };
}

export interface WebhookHandlingResult {
  readonly response: WebhookResponse;
  /** Resolves once the asynchronous recording/dispatch work finishes. Never rejects. */
  readonly settled: Promise<void>;
}

const defaultLog = (message: string): void => {
  console.log(message);
};

/**
 * Handles one delivery. The caller must send `response` to the client
 * immediately and let `settled` continue in the background — awaiting
 * `settled` before responding would defeat the 5-second acknowledgement
 * window this whole design exists to respect.
 */
export const handleWebhookRequest = (
  deps: WebhookHandlerDeps,
  input: WebhookRequestInput,
): WebhookHandlingResult => {
  const log = deps.log ?? defaultLog;

  // Reject before any processing: signature verification is the only
  // defence against a forged event. A plain unsigned curl reached this
  // endpoint during testing (docs/API-BEHAVIOUR.md section 8).
  if (!verifyWebhookSignature(input.rawBody, input.signatureHeader, deps.secret)) {
    return {
      response: { status: 401, body: { ok: false, error: 'invalid signature' } },
      settled: Promise.resolve(),
    };
  }

  return {
    response: { status: 200, body: { ok: true } },
    settled: processVerifiedEvent(deps, log, input),
  };
};

const processVerifiedEvent = async (
  deps: WebhookHandlerDeps,
  log: (message: string) => void,
  input: WebhookRequestInput,
): Promise<void> => {
  const eventId = input.eventIdHeader;
  if (eventId === undefined || eventId === '') {
    log('webhook: missing x-razorpay-event-id, cannot deduplicate; dropping');
    return;
  }

  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(input.rawBody.toString('utf8')) as WebhookEnvelope;
  } catch (cause) {
    log(
      `webhook: body is not valid JSON despite a valid signature: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return;
  }

  if (!HANDLED_EVENT_TYPES.has(envelope.event)) {
    // Ignore the invoice, settlement, fund_account, refund and engage
    // families deliberately (docs/API-BEHAVIOUR.md section 12).
    return;
  }

  const recorded = await recordWebhookEvent(deps.db, {
    eventId,
    eventType: envelope.event,
    payload: envelope,
  });

  if (!recorded.ok) {
    log(`webhook: failed to record ${eventId}: ${recorded.error.message}`);
    return;
  }

  if (recorded.value === 'duplicate') {
    // Expected: Razorpay retries on a slow or timed-out ack. Already
    // recorded and dispatched once.
    return;
  }

  log(describeWebhookEvent(envelope));
};

export const createWebhookRouter = (deps: WebhookHandlerDeps): Router => {
  const log = deps.log ?? defaultLog;
  const router = express.Router();

  router.post(
    WEBHOOK_PATH,
    // Raw, not JSON: the signature is computed over the exact bytes on
    // the wire. Parsing and re-serialising here would risk a whitespace
    // or key-order difference silently breaking the hash.
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req: Request, res: Response) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      const { response, settled } = handleWebhookRequest(deps, {
        rawBody,
        signatureHeader: req.header(SIGNATURE_HEADER),
        eventIdHeader: req.header(EVENT_ID_HEADER),
      });

      res.status(response.status).json(response.body);

      void settled.catch((cause) => {
        log(
          `webhook: unhandled error processing event: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      });
    },
  );

  return router;
};
