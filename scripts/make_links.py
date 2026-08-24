"""Create one Razorpay payment link per test-card scenario.

Resumable: skips scenarios already in data/samples/link_map.json.
Throttled + retries on HTTP 429 with exponential backoff.
Reads RZP_KEY / RZP_SECRET from the environment. urllib only.
"""
import base64
import json
import os
import pathlib
import time
import urllib.error
import urllib.request

API = "https://api.razorpay.com/v1"
KEY = os.environ["RZP_KEY"]
SECRET = os.environ["RZP_SECRET"]
MAP = pathlib.Path("data/samples/link_map.json")

THROTTLE_SEC = 4
MAX_RETRIES = 5

CARDS = {
    "success_baseline": "4100 2800 0000 1007",
    "payment_timed_out": "4100 2800 0009 0000",
    "insufficient_fund": "4100 2800 0008 0001",
    "payment_cancelled": "4100 2800 0007 0002",
    "card_declined_a": "4100 2800 0006 0003",
    "card_declined_b": "4100 2800 0005 0004",
    "card_declined_c": "4100 2800 0004 0005",
    "card_disabled_online": "4100 2800 0003 0006",
    "card_number_invalid": "4100 2800 0001 0008",
    "gateway_technical_error": "4100 2800 0002 0007",
    "authentication_failed": "4100 2800 0000 0009",
    "otp_fail_baseline": "4100 2800 0000 1007",
    "abandon_baseline": "4100 2800 0000 1007",
}


def post(path, payload):
    token = base64.b64encode(f"{KEY}:{SECRET}".encode()).decode()
    delay = 5
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(
            f"{API}{path}", data=json.dumps(payload).encode(), method="POST")
        req.add_header("Authorization", f"Basic {token}")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            if e.code == 429:
                print(f"  429, backing off {delay}s (attempt {attempt + 1})")
                time.sleep(delay)
                delay *= 2
                continue
            raise SystemExit(f"HTTP {e.code}: {body}")
    raise SystemExit("gave up after repeated 429s")


def bootstrap():
    """Rebuild the map from links already created on Razorpay's side."""
    token = base64.b64encode(f"{KEY}:{SECRET}".encode()).decode()
    req = urllib.request.Request(f"{API}/payment_links")
    req.add_header("Authorization", f"Basic {token}")
    with urllib.request.urlopen(req) as r:
        links = json.loads(r.read()).get("payment_links", [])
    found = {}
    for l in links:
        scenario = (l.get("notes") or {}).get("scenario")
        if scenario in CARDS:
            found[scenario] = {
                "card": CARDS[scenario],
                "plink_id": l["id"],
                "short_url": l["short_url"],
            }
    return found


def main():
    MAP.parent.mkdir(parents=True, exist_ok=True)
    out = json.loads(MAP.read_text()) if MAP.exists() else bootstrap()
    MAP.write_text(json.dumps(out, indent=2))

    todo = [s for s in CARDS if s not in out]
    print(f"{len(out)} already created, {len(todo)} to go\n")

    for scenario in todo:
        card = CARDS[scenario]
        body = {
            "amount": 49900,
            "currency": "INR",
            "description": f"revenant {scenario}",
            "customer": {
                "name": "Test Customer",
                "email": "test@example.com",
                "contact": "+919000090000",
            },
            "notify": {"sms": False, "email": False},
            "reference_id": f"rev_{scenario}",
            "notes": {"scenario": scenario},
        }
        link = post("/payment_links", body)
        out[scenario] = {
            "card": card,
            "plink_id": link["id"],
            "short_url": link["short_url"],
        }
        MAP.write_text(json.dumps(out, indent=2))
        print(f"{scenario:26s} {card:22s} {link['short_url']}")
        time.sleep(THROTTLE_SEC)

    print(f"\n{len(out)}/{len(CARDS)} links in {MAP}")


if __name__ == "__main__":
    main()
