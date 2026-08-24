import json, pathlib

FIELDS = {"email": "test@example.com", "contact": "+919000090000"}

def scrub(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in FIELDS:
                o[k] = FIELDS[k]
            elif k == "name":
                o[k] = "Test Customer"
            else:
                scrub(v)
    elif isinstance(o, list):
        for i in o:
            scrub(i)

for p in pathlib.Path("data/samples").glob("*.json"):
    d = json.loads(p.read_text())
    scrub(d)
    p.write_text(json.dumps(d, indent=2))
    print("redacted", p)
