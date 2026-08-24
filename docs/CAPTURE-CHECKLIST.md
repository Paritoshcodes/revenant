# Test-mode payment capture checklist

Amount is Rs 499 on every link. Random CVV, any future expiry date.

Test mode shows either a mock bank page with Success / Failure buttons,
or an OTP page. Whichever appears, take the failure path unless noted.
OTP rule: 4 to 10 digits succeeds, under 4 digits fails.

Time the whole run. That number decides whether Playwright is needed.

| # | Scenario | Card | Link | Action |
|---|---|---|---|---|
| 1 | success_baseline | 4100 2800 0000 1007 | https://rzp.io/rzp/aPC5Ss6 | SUCCESS |
| 2 | payment_timed_out | 4100 2800 0009 0000 | https://rzp.io/rzp/YHtPH0c4 | FAILURE |
| 3 | insufficient_fund | 4100 2800 0008 0001 | https://rzp.io/rzp/Td2xkR4 | FAILURE |
| 4 | payment_cancelled | 4100 2800 0007 0002 | https://rzp.io/rzp/R1mHrNEM | FAILURE |
| 5 | card_declined_a | 4100 2800 0006 0003 | https://rzp.io/rzp/iBUPkMhw | FAILURE |
| 6 | card_declined_b | 4100 2800 0005 0004 | https://rzp.io/rzp/yD6Fg7cg | FAILURE |
| 7 | card_declined_c | 4100 2800 0004 0005 | https://rzp.io/rzp/mQKXqNkD | FAILURE |
| 8 | card_disabled_online | 4100 2800 0003 0006 | https://rzp.io/rzp/qdHFN3A6 | FAILURE |
| 9 | card_number_invalid | 4100 2800 0001 0008 | https://rzp.io/rzp/qAAqWAG | FAILURE |
| 10 | gateway_technical_error | 4100 2800 0002 0007 | https://rzp.io/rzp/sSBxxXyU | FAILURE |
| 11 | authentication_failed | 4100 2800 0000 0009 | https://rzp.io/rzp/E1zwrF6 | FAILURE |
| 12 | otp_fail_baseline | 4100 2800 0000 1007 | https://rzp.io/rzp/3G15A5U | OTP under 4 digits |
| 13 | abandon_baseline | 4100 2800 0000 1007 | https://rzp.io/rzp/4Viq0gE | close tab, do not submit |

Already captured separately:
international_transaction_not_allowed (Visa 4111 1111 1111 1111)

## After all thirteen

    python scripts/capture.py
    git add -A && git commit -m "chore: capture full test-mode decline taxonomy"

## Observed API behaviour, test mode

- Payment links: roughly 5 writes before HTTP 429; needed ~40s backoff to clear
- Orders accept a duplicate `receipt` and create a second order
- Payment links reject a duplicate `reference_id`
- Idempotency must therefore be owned in our own layer, not delegated
