"""Engine entrypoint. Health and the Layer 2 synthetic population so far.

The recovery probability model, the policy function, the LLM diagnosis and
messaging calls, and the estimators mount here as they land. The policy
function decides; the LLM never does. Routing only -- logic lives in
population.py, outcomes.py, and whatever follows them.
"""

from __future__ import annotations

import secrets

from fastapi import FastAPI
from pydantic import BaseModel
from revenant_contracts import observed_reasons, policy_grid

from .population import Population, generate_population

app = FastAPI(title="revenant-engine", version="0.0.0")


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "engine",
        "grid_rows": len(policy_grid()),
        "observed_reasons": list(observed_reasons()),
    }


class PopulationRequest(BaseModel):
    n: int = 2000
    # Optional: if omitted, a seed is generated and returned in the
    # response (see generate_population's own doc), never silently
    # reproducible-by-accident. The gateway and dashboard both need to be
    # able to ask for a specific, reproducible world by passing one back.
    seed: int | None = None


@app.post("/population")
def population(request: PopulationRequest) -> Population:
    """A Layer 2 synthetic population. Every figure in the response is
    ESTIMATED (synthetic), never OBSERVED -- CLAUDE.md hard rule 6."""
    seed = request.seed if request.seed is not None else secrets.randbits(63)
    return generate_population(request.n, seed=seed)
