/**
 * Razorpay API shapes, narrowed to the fields we actually read.
 *
 * Field names and nullability follow the redacted real responses in
 * data/samples/. Anything not observed there is typed permissively rather
 * than guessed at precisely.
 */
import type { ErrorSource, ErrorStep } from '@revenant/contracts';

/** Razorpay's error envelope: `{ "error": { ... } }`. */
export interface RzpErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly description?: string;
    readonly source?: string;
    readonly step?: string;
    readonly reason?: string;
    readonly metadata?: Record<string, unknown>;
  };
}

export interface RzpOrder {
  readonly id: string;
  readonly entity: 'order';
  readonly amount: number;
  readonly amount_paid: number;
  readonly amount_due: number;
  readonly currency: string;
  /** Not deduplicated by Razorpay. Two creates with the same receipt make two orders. */
  readonly receipt: string | null;
  readonly status: 'created' | 'attempted' | 'paid';
  readonly attempts: number;
  readonly notes: Record<string, string> | readonly never[];
  readonly created_at: number;
}

export interface RzpPaymentLink {
  readonly id: string;
  readonly entity: 'payment_link';
  readonly amount: number;
  readonly currency: string;
  readonly status: 'created' | 'partially_paid' | 'expired' | 'cancelled' | 'paid';
  readonly short_url: string;
  /**
   * Null until the first attempt (docs/API-BEHAVIOUR.md section 2): a link
   * just created has no order yet. Correlation logic must tolerate this.
   */
  readonly order_id: string | null;
  /** Razorpay DOES reject a duplicate of this, unlike order receipts. */
  readonly reference_id: string | null;
  readonly description: string | null;
  readonly amount_paid: number;
  readonly notes: Record<string, string> | readonly never[];
  readonly created_at: number;
}

export interface RzpCard {
  readonly id: string;
  readonly last4: string;
  readonly network: string | null;
  readonly type: string | null;
  readonly issuer: string | null;
  readonly international: boolean;
  readonly sub_type: string | null;
}

export interface RzpPayment {
  readonly id: string;
  readonly entity: 'payment';
  readonly amount: number;
  readonly currency: string;
  readonly status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  readonly order_id: string | null;
  readonly method: string;
  readonly captured: boolean;
  readonly card: RzpCard | null;
  readonly description: string | null;
  readonly notes: Record<string, string> | readonly never[];
  /** Observed BAD_REQUEST_ERROR where the docs imply GATEWAY_ERROR. Stored raw. */
  readonly error_code: string | null;
  readonly error_description: string | null;
  readonly error_source: ErrorSource | null;
  readonly error_step: ErrorStep | null;
  readonly error_reason: string | null;
  /** Populated means the transaction reached the acquirer. Null means it did not. */
  readonly acquirer_data: { readonly auth_code: string | null } | null;
  readonly created_at: number;
}

export interface RzpList<T> {
  readonly entity: 'collection';
  readonly count: number;
  readonly items: readonly T[];
}

// -- request inputs --------------------------------------------------------

export interface CreateOrderInput {
  readonly amount_paise: number;
  readonly currency?: string;
  readonly receipt?: string;
  readonly notes?: Record<string, string>;
}

export interface CreatePaymentLinkInput {
  readonly amount_paise: number;
  readonly currency?: string;
  readonly description?: string;
  /** Razorpay rejects a duplicate. Our idempotency key is a natural fit. */
  readonly reference_id?: string;
  readonly customer?: {
    readonly name?: string;
    readonly email?: string;
    readonly contact?: string;
  };
  readonly notify?: { readonly sms?: boolean; readonly email?: boolean };
  readonly notes?: Record<string, string>;
  readonly expire_by?: number;
}
