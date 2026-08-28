"""tests/test_main.py

Covers the thin POST /population and POST /propose endpoints: routing
only, per main.py's own doc comment -- the generation logic lives in
test_population.py, the policy logic in test_policy.py / test_model.py.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from revenant_contracts import policy_grid
from revenant_engine.main import app

client = TestClient(app)


def test_health_reports_seven_grid_rows():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["grid_rows"] == 7


def test_population_endpoint_with_explicit_seed_is_deterministic():
    body = {"n": 100, "seed": 777}
    first = client.post("/population", json=body)
    second = client.post("/population", json=body)

    assert first.status_code == 200
    assert first.json() == second.json()
    assert first.json()["seed"] == 777
    assert len(first.json()["transactions"]) == 100


def test_population_endpoint_without_seed_generates_and_returns_one():
    response = client.post("/population", json={"n": 50})
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body["seed"], int)

    # Reproducible by re-supplying the returned seed.
    replay = client.post("/population", json={"n": 50, "seed": body["seed"]})
    assert replay.json() == body


def test_population_endpoint_defaults_n_to_2000():
    response = client.post("/population", json={"seed": 1})
    assert response.status_code == 200
    assert len(response.json()["transactions"]) == 2000


def test_propose_endpoint_matches_the_grids_own_action_for_every_cell():
    for row in policy_grid():
        response = client.post(
            "/propose", json={"error_source": row.error_source, "error_step": row.error_step}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["grid_cell"] == row.grid_cell
        assert body["action"] == row.action
        assert body["propensity"] == 1.0


def test_propose_endpoint_defaults_are_applied_when_omitted():
    response = client.post(
        "/propose", json={"error_source": "gateway", "error_step": "payment_authorization"}
    )
    assert response.status_code == 200
    body = response.json()
    assert 0.0 <= body["recovery_probability"] <= 1.0


def test_propose_endpoint_accepts_full_diagnosis():
    response = client.post(
        "/propose",
        json={
            "error_source": "bank",
            "error_step": "payment_authorization",
            "amount_paise": 250_000,
            "hour_ist": 22,
            "attempt_number": 2,
        },
    )
    assert response.status_code == 200
    assert response.json()["action"] == "retry_on_timing_window"
