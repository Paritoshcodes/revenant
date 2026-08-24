"""Fetch all test-mode payments, save each as a sample, print the decline taxonomy.

Run after paying the links from make_links.py.
Writes data/samples/payment_<id>.json and data/samples/taxonomy.json.
"""
import base64
import json
import os
import pathlib
import urllib.request

API = "https://api.razorpay.com/v1"
KEY = os.environ["RZP_KEY"]
SECRET = os.environ["RZP_SECRET"]
SAMPLES = pathlib.Path("data/samples")

REDACT = {"email": "test@example.com", "contact": "+919000090000"}


def scrub(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in REDACT:
                o[k] = REDACT[k]
            elif k == "name":
                o[k] = "Test Customer"
            else:
                scrub(v)
    elif isinstance(o, list):
        for i in o:
            scrub(i)


def get(path):
    req = urllib.request.Request(f"{API}{path}")
    token = base64.b64encode(f"{KEY}:{SECRET}".encode()).decode()
    req.add_header("Authorization", f"Basic {token}")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def main():
    SAMPLES.mkdir(parents=True, exist_ok=True)
    payments = get("/payments?count=100")["items"]

    rows = []
    for p in payments:
        scrub(p)
        (SAMPLES / f"payment_{p['id']}.json").write_text(json.dumps(p, indent=2))
        rows.append({
            "id": p["id"],
            "status": p["status"],
            "method": p.get("method"),
            "error_code": p.get("error_code"),
            "error_source": p.get("error_source"),
            "error_step": p.get("error_step"),
            "error_reason": p.get("error_reason"),
            "auth_code": (p.get("acquirer_data") or {}).get("auth_code"),
            "card_last4": (p.get("card") or {}).get("last4"),
            "issuer": (p.get("card") or {}).get("issuer"),
        })

    (SAMPLES / "taxonomy.json").write_text(json.dumps(rows, indent=2))

    hdr = f"{'reason':38s} {'source':12s} {'step':22s} {'code':20s} {'auth':6s} last4"
    print(hdr)
    print("-" * len(hdr))
    seen = set()
    for r in sorted(rows, key=lambda x: str(x["error_reason"])):
        key = (r["error_reason"], r["error_source"], r["error_step"])
        if key in seen:
            continue
        seen.add(key)
        print(f"{str(r['error_reason']):38s} {str(r['error_source']):12s} "
              f"{str(r['error_step']):22s} {str(r['error_code']):20s} "
              f"{str(r['auth_code']):6s} {r['card_last4']}")
    print(f"\n{len(payments)} payments, {len(seen)} distinct source/step/reason combos")


if __name__ == "__main__":
    main()
