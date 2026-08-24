/**
 * Row hashing: hash = sha256(prev_hash + canonical_json(payload)).
 *
 * See docs/ARCHITECTURE.md, Audit chain.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical-json.js';

export const hashPayload = (prevHash: string, payload: unknown): string =>
  createHash('sha256')
    .update(prevHash + canonicalJson(payload), 'utf8')
    .digest('hex');
