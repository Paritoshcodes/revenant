"""Engine entrypoint. Health only at this stage.

The recovery probability model, the policy function, the LLM diagnosis and
messaging calls, the synthetic generator and the estimators mount here as
they land. The policy function decides; the LLM never does.
"""

from __future__ import annotations

from fastapi import FastAPI
from revenant_contracts import observed_reasons, policy_grid

app = FastAPI(title="revenant-engine", version="0.0.0")


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "engine",
        "grid_rows": len(policy_grid()),
        "observed_reasons": list(observed_reasons()),
    }
