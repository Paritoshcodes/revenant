"""Engine entrypoint. Health and the Layer 2 synthetic population so far.

The recovery probability model, the policy function, the LLM diagnosis and
messaging calls, and the estimators mount here as they land. The policy
function decides; the LLM never does. Routing only -- logic lives in
population.py, outcomes.py, and whatever follows them.
"""

from __future__ import annotations

import secrets
from functools import lru_cache

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from revenant_contracts import observed_reasons, policy_grid

from .calibration import CalibrationResult, run_calibration
from .classifier import ExactClassifier, LlmClassifier, LlmClassifierConfigurationError
from .confidence_gate import GatedClassification, apply_confidence_gate
from .experiment import BootstrapMethod, ExperimentResult, run_experiment
from .policy import Diagnosis, ProposedAction, propose_action
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


@app.post("/propose")
def propose(diagnosis: Diagnosis) -> ProposedAction:
    """Proposes an action for one diagnosis via policy.propose_action.
    Routing only -- see policy.py for the decision logic. NOT wired to the
    gateway in this session; that is separate, later integration work."""
    return propose_action(diagnosis)


class ExperimentRequest(BaseModel):
    n: int = 2000
    # Optional, matching /population's own pattern: generated and
    # returned on the result if omitted, never silently reproducible by
    # accident.
    seed: int | None = None
    # "pooled" default matches experiment.py's own default (the original
    # method, kept available rather than replaced) -- see
    # docs/DECISIONS.md for the measured pooled-vs-stratified comparison
    # this parameter exists to let a caller reproduce.
    bootstrap_method: BootstrapMethod = "pooled"


@app.post("/experiment")
def experiment(request: ExperimentRequest) -> ExperimentResult:
    """One randomised holdout experiment per docs/EXPERIMENT-PROTOCOL.md.
    Routing only -- see experiment.py for the runner, the mandatory
    coupling guard, and both estimates (never blended)."""
    seed = request.seed if request.seed is not None else secrets.randbits(63)
    return run_experiment(request.n, seed=seed, bootstrap_method=request.bootstrap_method)


class CalibrationRequest(BaseModel):
    # 20, not the protocol's own 500: an interactive-use default so a
    # request from the dashboard returns promptly. The real 500-replication
    # figure is requested explicitly, not baked in as this endpoint's
    # default -- see docs/DECISIONS.md for that run's actual numbers.
    replications: int = 20
    master_seed: int | None = None
    bootstrap_method: BootstrapMethod = "pooled"


@app.post("/calibration")
def calibration(request: CalibrationRequest) -> CalibrationResult:
    """The calibration harness per docs/EXPERIMENT-PROTOCOL.md's
    "## Calibration check". Routing only -- see calibration.py; nothing
    here is tuned toward a target coverage figure."""
    master_seed = request.master_seed if request.master_seed is not None else secrets.randbits(63)
    return run_calibration(request.replications, master_seed=master_seed, bootstrap_method=request.bootstrap_method)


class ClassifyRequest(BaseModel):
    error_code: str
    error_description: str
    error_source: str | None = None
    error_step: str | None = None
    # Optional fast-path key: when present, used directly for an exact
    # decline-taxonomy.json lookup (see classifier.ExactClassifier). When
    # absent, error_description is normalised and tried instead.
    error_reason: str | None = None


@lru_cache(maxsize=1)
def _default_exact_classifier() -> ExactClassifier:
    return ExactClassifier()


@lru_cache(maxsize=1)
def _default_llm_classifier() -> LlmClassifier:
    # Constructed lazily, only the first time a request actually misses
    # ExactClassifier -- GROQ_API_KEY absent must never block the
    # exact-lookup fast path. lru_cache does not cache a raised exception,
    # so a missing key fails this same way on every LLM-needing request
    # until fixed, rather than being cached as a permanent failure.
    return LlmClassifier()


@app.post("/classify")
def classify(request: ClassifyRequest) -> GatedClassification:
    """Open-world classification: ExactClassifier first (free, and the
    only path exercised when GROQ_API_KEY is absent), LlmClassifier
    only on a miss, gated by confidence_gate before returning. Routing
    only -- see classifier.py and confidence_gate.py for the logic."""
    exact_result = _default_exact_classifier().classify(
        error_code=request.error_code,
        error_description=request.error_description,
        error_source=request.error_source,
        error_step=request.error_step,
        error_reason=request.error_reason,
    )
    if exact_result.grid_cell is not None:
        return apply_confidence_gate(exact_result)

    try:
        llm = _default_llm_classifier()
    except LlmClassifierConfigurationError as exc:
        # A missing key is a configuration fact, not a classification
        # judgement -- surfaced as a clear error rather than disguised as
        # a low-confidence (but silently fake) gated result.
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    llm_result = llm.classify(
        error_code=request.error_code,
        error_description=request.error_description,
        error_source=request.error_source,
        error_step=request.error_step,
        error_reason=request.error_reason,
    )
    return apply_confidence_gate(llm_result)
