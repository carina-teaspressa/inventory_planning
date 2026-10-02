# Cube planning

A demand plan and inventory view for Teaspressa cubes. It turns open ShipStation orders and retail POs into **batches to make, by flavor**, and shows which **kits to build**, which **Mini SKUs** go in each kit, and what a **single PO** takes.

It's a static site (GitHub Pages). A GitHub Action pulls ShipStation every morning and commits the result. Nothing else runs on a server.

## The pages

| Page | Answers |
|---|---|
| **Plan** | How many batches of each flavor do we need to make? One "Batches needed" number per flavor, in whole batches. Defaults to **All demand**, with a **By production window** toggle. Open a flavor to see the items ordered, in units, with a color dot for the product type. Mini tubes and labels (cap color by SKU suffix) are listed here too. |
| **Kits** | Which kits to build, the Mini SKUs inside each one, and **tubes to make by Mini SKU with batches per flavor**. There's a jump link to that section. |
| **POs** | One PO at a time: its SKUs, batches by flavor, kits, and Mini tubes. POs are also counted in Plan and Kits. |
| **Inventory** | Built and ready units by SKU, split into **Built (new)** and **Legacy**, and loose cubes by recipe. "Makes up to" shows units for sellable products, or kit tubes (cubes ÷ 6) for flavors that only appear inside kits. Count problems are listed on Data review. |
| **Data review** | Everything to check, in two groups. *Can change the numbers* (SKUs not found, kits with no contents, bad counts, Faire orders) and *Fix over time* (kits whose contents look short, unnamed flavors, assumptions, and so on). The nav shows two counts, one per group. |
| **Data and rules** | Sources, planning rules (batch size, windows, Faire), and the editable products, kit components, flavors and aliases. |

## How the plan works

- **Batches.** One batch is 200 cubes of one flavor (`batch_cubes` in `rules.json`, editable on Data and rules). A flavor's batches are its cubes divided by 200, rounded up. The items inside a row and the production windows are split into whole numbers that add up to that total.
- **Recipes.** The plan is keyed on recipe, not LM code. `flavors.csv` `same_recipe_as` merges flavors that are the same recipe (033 uses 034). A recipe that differs by inclusions stays separate: give its products a `recipe_code` in `products.csv` (TB003 uses `003-NI`) and add that code to `flavors.csv`.
- Mini, Stick, Tallboy and Bulk Bag: `units x cubes_per_unit`. Kits: each tube in `product_components.csv`; the Mini SKU comes from the label code (`LM001-GC` is `SM001-GC`). Kit-only Minis don't need to be in products. Rimmers (`-GR`) hold no cubes. If a kit lists the same label twice, it is counted once (use `qty` for two of a kind) and reported on Data review.
- **Cap color follows the SKU suffix.** GC and CB rust, PC green, SP, PM, AW and BL cream, GR none. The names and colors live in `LABEL_TYPES` at the top of `js/core.js`.
- **Legacy vs new.** Legacy Minis are an older, unlabeled tube in a different size, counted under a short SKU with no suffix (`SM001` for `SM001-GC`). They are **not** stock for the new SKU and are **never used in kits**, so their LM codes don't apply. An order placed under the short SKU is legacy demand: it is filled from legacy stock only, adds no batches or label tubes, and shows as short on Data review if legacy stock can't cover it. Download built on the Inventory page writes legacy counts back under their short SKU.
- **Built stock** (new, labeled SKUs) takes units off demand, oldest first. Built Minis are shared between direct Mini orders and kit tubes. Built kits only reduce kits that are on order, so extras are spare.
- **Case SKUs** count as the case quantity for ShipStation orders. PO units are already finished units.
- **Windows.** ShipStation orders land by age (editable). POs land the week before their commit date, minus `lead_weeks`.
- Lines with no SKU in ShipStation are custom items and are ignored.

## POs and ShipStation

A PO can also exist in ShipStation. To count it once, put its ShipStation order number (or the start of it, like `MO-PS`) in `replaces_shipstation` on the PO line. Use `;` between several. The POs page shows which POs replace ShipStation lines. Data review lists ShipStation orders that look like POs (`PO3007-`) so a double count can't hide.

## Faire orders

Faire orders sync into ShipStation but are shipped from Faire, so ShipStation never marks them shipped and they can stay open. They're recognised by the ShipStation **store name** (the daily pull now records it) or, failing that, by an order number of 10 capital letters and numbers (`faire.pattern`). Under Data and rules, Planning rules, choose how to count them:

- count every Faire order (the default, so nothing disappears silently)
- ignore Faire orders older than N days
- count only orders on `data/csv/faire_open_orders.csv`
- ignore all Faire orders

A direct Faire API pull that writes `faire_open_orders.csv` each morning is the most accurate fix, and needs Faire API access.

## Data files

```
data/csv/products.csv            every SKU. Optional recipe_code column
data/csv/product_components.csv  Mini tubes inside each kit (label_code is what counts)
data/csv/flavors.csv             flavor_code, name, notes, same_recipe_as
data/csv/sku-aliases.csv         old SKU to current SKU (matched in the background)
data/csv/po_lines.csv            retail POs and allocations
data/csv/inventory_built.csv     sku,on_hand,counted_at,notes
data/csv/inventory_cubes.csv     flavor_code,cubes_on_hand,counted_at,notes
data/csv/faire_open_orders.csv   order_number,notes  (optional)
data/json/open_orders.json       written by the ShipStation pull
data/json/rules.json             windows, statuses, batch size, Faire rule
```

Uploads, in-app edits and counts are saved in **this browser only**. To make them permanent, use Download CSV on the page and commit the file.

## Run it

Open the GitHub Pages site, or locally:

```
python3 -m http.server      # then open http://localhost:8000
node tests/check.js         # checks the numbers against the repo data
```

## Still open

- **Inventory source and ShipStation numbers.** Counts are typed or uploaded. Confirm whether the ShipStation inventory figure is physical stock or already net of what ShipStation reserves. If it's net, subtracting orders again would under-batch.
- **Tallboy recipes.** Notes say TB005 and TB006 use other flavors (035, 036, 009). A tallboy holding two flavors can't be planned until its split is known.
- **Shared edits.** Because the site is static, edits aren't shared until a database sits behind it.
