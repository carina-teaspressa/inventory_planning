# Cube planning

A demand plan and inventory view for Teaspressa cubes. It turns open ShipStation orders and retail POs into **cubes to make, by flavor**, and shows which **kits to build** and which **Mini SKUs** go in each one.

It's a static site (GitHub Pages). A GitHub Action pulls ShipStation every morning and commits the result. Nothing else runs on a server.

## The four pages

| Page | Answers |
|---|---|
| **Plan** | How many cubes of each flavor do we need to make? Defaults to **All demand**, with a **By production window** toggle. Filter by product type. Open a flavor to see the SKUs behind it. Mini tubes and labels (LM codes) are listed here and nowhere else. |
| **Kits** | Which kits need building, which Mini SKUs are inside each one, how many are built, and which flavors and label variants (cafe or cocktail) the kits need cubes for. |
| **Inventory** | What's built and ready (finished units by SKU) and what cubes are on hand by flavor, plus what those cubes could make. |
| **Data and rules** | What can't be counted and how to fix it, where each file comes from, window rules, and editable products, kit components, flavors and aliases. |

## How the plan works

- The plan is keyed on **flavor code** (the recipe), not on LM codes. LM codes only describe Mini tubes.
- Mini, Stick, Tallboy and Bulk Bag: `units x cubes_per_unit`, flavor from the product row.
- Kits: each component tube in `product_components.csv`. The Mini SKU is worked out from the label code (`LM001-GC` is `SM001-GC`). Rimmers (`-GR`) hold no cubes.
- Case SKUs (`C6-...`, `C12-...`) count as the case quantity for ShipStation orders. PO units are already finished units.
- Anything with `include_in_plan = N` is left out and listed under "Left out by your settings".
- **Built counts** reduce demand for that SKU, oldest demand first. Built Minis are shared between direct Mini orders and the tubes inside kits.
- **Cube counts** are netted against each flavor: `to make = needed - on hand`.
- **Production windows**: ShipStation orders land by age (editable under Planning rules). PO lines land the week before their commit date, minus `lead_weeks`.
- Order SKUs are matched in this order: exact SKU, then `sku-aliases.csv`, then `-S` samples, then a bare base SKU with one match (`SM009` becomes `SM009-PM`, flagged as an assumption).
- Kits with no contents on file are estimated from `cubes_per_unit` in one "no contents" row so the totals stay honest. They aren't assigned to a flavor.

## Data files

```
data/csv/products.csv            every SKU: type, flavor_code, cubes_per_unit, case size, include_in_plan
data/csv/product_components.csv  Mini tubes inside each kit (label_code is what counts)
data/csv/flavors.csv             flavor_code to name. Fill in the blanks
data/csv/sku-aliases.csv         old SKU to current SKU
data/csv/po_lines.csv            retail POs
data/csv/inventory_built.csv     sku,on_hand,counted_at,notes
data/csv/inventory_cubes.csv     flavor_code,cubes_on_hand,counted_at,notes
data/json/open_orders.json       written by the ShipStation pull. Order number, date, status, SKU, qty only
data/json/rules.json             window rules and which statuses count
```

Uploads, in-app edits and counts are saved in **this browser only**. To make them permanent for everyone, use Download CSV on the page and commit the file to the matching path above.

## Run it

Open the GitHub Pages site, or locally:

```
python3 -m http.server
# then open http://localhost:8000
node tests/check.js     # checks the numbers against the repo data
```

## Still open

- **Inventory source.** Built and cube counts are typed or uploaded for now. The page reads them through `inventory_built.csv` and `inventory_cubes.csv`, so swapping in another source later only changes where those two files come from.
- **Shared edits.** Because the site is static, edits aren't shared between people until a database sits behind it.
- **Flavor names and kit contents.** Many flavors have no name yet and many kits have no contents on file. Both show up in Data and rules.
