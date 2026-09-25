# ShipStation pull: setup

## 1. Add the files
Copy these into the `inventory_planning` repo, keeping the folders:

    .github/workflows/pull-shipstation.yml
    scripts/pull_shipstation.py
    data/csv/products.csv
    data/csv/product_components.csv

## 2. Add your ShipStation keys as secrets
GitHub repo -> Settings -> Secrets and variables -> Actions -> New repository secret

- `SHIPSTATION_API_KEY`
- `SHIPSTATION_API_SECRET`

Never put the keys in a file in the repo.

## 3. Run it once by hand
GitHub repo -> Actions -> "Pull ShipStation open orders" -> Run workflow.
When it finishes, `data/json/open_orders.json` appears in the repo.

If it fails at the push step, go to Settings -> Actions -> General ->
Workflow permissions and choose "Read and write permissions".

## What it does
- Runs every day at 6:00 AM Arizona time (13:00 UTC), plus whenever you click Run workflow.
- GitHub may start scheduled runs a few minutes late at busy times.
- Pulls every ShipStation store, including manual orders, with status Awaiting Shipment or On Hold.
- Saves only order number, order date, status, SKU and quantity. No customer details.
- Replaces the file each run, so shipped or cancelled orders drop off.
