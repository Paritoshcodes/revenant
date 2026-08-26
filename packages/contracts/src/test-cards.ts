/**
 * The one test card that is not a decline reason: it succeeds. Kept
 * alongside decline-taxonomy.json's test_cards rather than inside it,
 * since it is not one of the taxonomy's rows.
 *
 * Consolidated here so no card number needs to appear in a script or test
 * outside packages/contracts/data/ (docs/DECISIONS.md).
 */
import testCardsData from '../data/test-cards.json' with { type: 'json' };

/** As documented, with spaces, matching decline-taxonomy.json's test_cards convention. */
export const BASELINE_SUCCESS_CARD: string = testCardsData.baseline_success_card;

/** Digits only, ready for Checkout's card.number field. */
export const BASELINE_SUCCESS_CARD_DIGITS: string = BASELINE_SUCCESS_CARD.replace(/\s/g, '');
