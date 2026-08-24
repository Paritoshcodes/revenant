# Revenant

Payment recovery agent that executes bounded retries on failed payments and
measures whether its own decisions caused incremental recovery, rather than
taking credit for payments that would have recovered anyway.

## Read before working

- @docs/ARCHITECTURE.md      layers, services, policy grid, guardrails, audit
- @docs/EXPERIMENT-PROTOCOL.md  FROZEN experiment parameters
- @docs/DECISIONS.md         observed API behaviour, why things are the way they are
- @docs/CHECKOUT-FLOW.md     Razorpay checkout selectors for Playwright

Read only the ones relevant to the current task. Do not explore the repo.
@docs/PRIOR-ART.md is for README and pitch work only, not for coding.

## Hard rules

1. The LLM never decides whether money moves. It produces diagnosis text,
   customer messages, and audit narratives. The policy function decides.
2. Every money action passes the guardrail layer. Guardrails can veto the
   policy. Guardrails are pure functions, no I/O, fully unit tested.
3. The audit log is append only and hash chained. Never update or delete.
4. Every Razorpay call carries an idempotency key derived from
   transaction_id + attempt_number, enforced in our own store. The gateway
   does not deduplicate for us (see DECISIONS.md).
5. Experiment parameters in EXPERIMENT-PROTOCOL.md are frozen. Never edit
   them to change a result.
6. Never report a recovery figure without its label: OBSERVED (Layer 1, real)
   or ESTIMATED (Layer 2 or 3, synthetic). Never merge them into one number.
7. Outbound Razorpay writes are throttled and backed off. ~5 writes trips a
   429; recovery needs ~40s.

## Stack

- gateway: Node 20, Express, TypeScript, Postgres, Playwright
- engine: Python 3.11, FastAPI, scikit-learn, numpy, scipy
- dashboard: React, Vite
- No microservices beyond these three. No Kubernetes, no broker, no RAG,
  no agent framework, no C++.

## Conventions

- External calls return typed failure results, never throw across boundaries
- Mandatory unit tests: guardrails, hash chain verifier, estimators
- Conventional commits, one concern per commit
- All sample JSON in data/samples is redacted via scripts/redact.py

## Working style

- Start non-trivial work in plan mode
- Reference files with @path
- Filter command output; never dump full test runs or API payloads
