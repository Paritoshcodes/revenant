"""Export one real experiment run for the dashboard to render.

NOT a mock and not a fetch layer. This runs the actual estimator in
apps/engine/src/revenant_engine/experiment.py, at the frozen protocol's
own N, with the shipped stratified bootstrap, and writes the result to
apps/dashboard/src/data/experiment.json.

Precomputed on purpose, matching docs/PLAN.md's demo decision for
calibration: the dashboard must render a real figure on a laptop with no
Python process running. Every number in the file is reproducible from the
`seed` it records.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from revenant_engine.experiment import (
    N_BOOTSTRAP_RESAMPLES,
    _bootstrap_stratified,
    run_experiment,
)
from revenant_engine.true_lift import compute_true_lift

SEED = 20260901
N = 2000
BINS = 48
OUT = Path(__file__).resolve().parents[3] / "apps" / "dashboard" / "src" / "data" / "experiment.json"


def verdict(lo: float, hi: float, n: int) -> str:
    """Derived from the interval, never from the point estimate.

    EXPERIMENT-PROTOCOL.md: at a control rate near 0.25, N=2000 gives
    roughly 80% power to detect 6pp. So an interval that contains zero at
    this N is a powered null, not an underpowered maybe -- it earns
    "no evidence of value", which the protocol names as a valid and
    honest output. Below that N it is only "keep running".
    """
    if lo > 0:
        return "deploy"
    if hi < 0:
        return "do_not_deploy"
    return "no_evidence" if n >= 2000 else "keep_running"


def main() -> int:
    result = run_experiment(N, seed=SEED, bootstrap_method="stratified")
    rows = result.rows
    est = result.estimates

    control = [r for r in rows if r.arm == "control"]
    treatment = [r for r in rows if r.arm == "treatment"]

    def arm_summary(arm_rows) -> dict[str, float | int]:
        n_arm = len(arm_rows)
        recovered = sum(1 for r in arm_rows if r.recovered)
        value = sum(r.recovered_value_paise for r in arm_rows)
        return {
            "n": n_arm,
            "recovered": recovered,
            "rate": recovered / n_arm,
            "totalValuePaise": value,
            "meanValuePaise": value / n_arm,
        }

    # The resample distribution itself, so the dashboard can draw the
    # histogram the interval was actually read off -- not a re-derived
    # bell curve. Same seed, same function the interval came from.
    rate_diffs, _value_diffs = _bootstrap_stratified(rows, SEED)
    counts, edges = np.histogram(rate_diffs, bins=BINS)

    payload = {
        "generated": "2026-09-01",
        "source": "apps/engine/scripts/export_dashboard_fixture.py",
        "seed": SEED,
        "n": N,
        "bootstrapMethod": est.bootstrap_method,
        "resamples": N_BOOTSTRAP_RESAMPLES,
        "estimand": compute_true_lift().net_true_lift_pp,
        "rate": {
            "point": est.recovery_rate_diff_pp.point_estimate,
            "lo": est.recovery_rate_diff_pp.lo,
            "hi": est.recovery_rate_diff_pp.hi,
        },
        "value": {
            "point": est.recovered_value_diff_paise.point_estimate,
            "lo": est.recovered_value_diff_paise.lo,
            "hi": est.recovered_value_diff_paise.hi,
        },
        "z": {"statistic": est.z_test_secondary.z_statistic, "pValue": est.z_test_secondary.p_value},
        "arms": {"control": arm_summary(control), "treatment": arm_summary(treatment)},
        "bandCutPointsPaise": list(result.amount_band_cutpoints_paise),
        "histogram": {
            "counts": [int(c) for c in counts],
            "edges": [float(e) for e in edges],
        },
        # THE VERDICT IS DERIVED FROM THE PRIMARY ESTIMATE, which
        # EXPERIMENT-PROTOCOL.md's "## Primary estimate" names as the
        # recovered-VALUE difference, not the rate difference. On this
        # run those two disagree: the rate interval excludes zero while
        # the value interval does not. Taking the flattering one would be
        # exactly the dishonesty this project exists to argue against, so
        # the verdict follows the protocol's own nomination and the
        # disagreement is surfaced rather than resolved silently.
        "verdict": verdict(est.recovered_value_diff_paise.lo, est.recovered_value_diff_paise.hi, N),
        "rateVerdict": verdict(est.recovery_rate_diff_pp.lo, est.recovery_rate_diff_pp.hi, N),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {OUT}")
    print(f"  rate  {payload['rate']['point']:.4f}pp  [{payload['rate']['lo']:.4f}, {payload['rate']['hi']:.4f}]")
    print(f"  value {payload['value']['point']:.2f}p  [{payload['value']['lo']:.2f}, {payload['value']['hi']:.2f}]")
    print(f"  verdict {payload['verdict']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
