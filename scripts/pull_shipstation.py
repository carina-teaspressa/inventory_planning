"""
Pull open ShipStation orders into data/json/open_orders.json.

Saves ONLY: order number, order date, status, and each line's SKU + quantity.
No customer names, addresses, emails, phone numbers or prices are written.

Each run is a fresh snapshot: the file is replaced, so shipped or cancelled
orders drop off automatically.

Needs two environment variables (set as GitHub repo secrets):
  SHIPSTATION_API_KEY
  SHIPSTATION_API_SECRET
"""
import base64, json, os, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

API = os.environ.get("SHIPSTATION_API_BASE", "https://ssapi.shipstation.com")
STATUSES = ["awaiting_shipment", "on_hold"]
PAGE_SIZE = 500
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "json", "open_orders.json")


def auth_header():
    key, secret = os.environ.get("SHIPSTATION_API_KEY"), os.environ.get("SHIPSTATION_API_SECRET")
    if not key or not secret:
        sys.exit("Missing SHIPSTATION_API_KEY or SHIPSTATION_API_SECRET.")
    return "Basic " + base64.b64encode(f"{key}:{secret}".encode()).decode()


def get(path, params, auth, tries=5):
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    for attempt in range(tries):
        req = urllib.request.Request(url, headers={"Authorization": auth, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = json.load(r)
                # Stay under the rate limit: pause if almost out of requests
                if int(r.headers.get("X-Rate-Limit-Remaining") or 10) <= 1:
                    time.sleep(int(r.headers.get("X-Rate-Limit-Reset") or 60) + 1)
                return body
        except urllib.error.HTTPError as e:
            if e.code == 401:
                sys.exit("ShipStation rejected the API key/secret (401). Check the repo secrets.")
            if e.code == 429 or e.code >= 500:
                wait = int(e.headers.get("X-Rate-Limit-Reset") or e.headers.get("Retry-After") or 30) + 1
                print(f"ShipStation returned {e.code}; waiting {wait}s (attempt {attempt + 1}/{tries})")
                time.sleep(wait)
                continue
            raise
    sys.exit(f"Gave up after {tries} attempts: {path}")


def main():
    auth = auth_header()
    lines, orders_seen = [], set()
    for status in STATUSES:
        page, pages = 1, 1
        while page <= pages:
            data = get("/orders", {"orderStatus": status, "pageSize": PAGE_SIZE, "page": page,
                                   "sortBy": "OrderDate", "sortDir": "ASC"}, auth)
            pages = data.get("pages") or 1
            for o in data.get("orders", []):
                oid = o.get("orderId")
                if oid in orders_seen:
                    continue
                orders_seen.add(oid)
                for it in o.get("items") or []:
                    if it.get("adjustment"):  # discount/adjustment lines, not products
                        continue
                    lines.append({
                        "order_number": str(o.get("orderNumber") or ""),
                        "order_date": (o.get("orderDate") or "")[:10],
                        "status": status,
                        "sku": (it.get("sku") or "").strip(),
                        "qty": int(it.get("quantity") or 0),
                    })
            page += 1

    lines.sort(key=lambda l: (l["order_date"], l["order_number"], l["sku"]))
    out = {
        "pulled_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "statuses": STATUSES,
        "order_count": len(orders_seen),
        "line_count": len(lines),
        "lines": lines,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print(f"Saved {len(orders_seen)} orders / {len(lines)} lines to data/json/open_orders.json")


if __name__ == "__main__":
    main()
