# Cal Track — Obsidian Plugin

Log what you eat into a [Table Calc](https://github.com/BenRuns/table-calc-plugin) table. Search a food database, pick a quantity and unit ("1 medium", "2 tbsp", "150 g", "6 oz"), and Cal Track writes a row with calories and macros. Table Calc keeps the totals live.

```markdown
{{calc}}
| Food | Qty | Unit | kcal | Protein | Carbs | Fat |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Bananas, raw | 1 | medium | 105 | 1.3 | 26.9 | 0.4 |
| Total 0% Greek Yoghurt (Fage) | 1 | cup | 123 | 23.4 | 6.8 | 0 |
| Oats | 40 | g | 150 | 5 | 27 | 2.5 |
| **Total** |  |  | =SUM(D1:D3) | =SUM(E1:E3) | =SUM(F1:F3) | =SUM(G1:G3) |
| **Goal** |  |  | 2000 |  |  |  |
| **Remaining** |  |  | =D5-D4 |  |  |  |
```

> **Requires Table Calc** for the `=SUM(...)` totals to render. Without it the rows still work, but the summary rows show raw formulas.

---

## Using it

| Command | What it does |
|---------|--------------|
| **Add food to log** | Search → pick a quantity and unit → adds a row. It goes into the log your cursor is in, or the first log in the note. If the note has no log yet, a new one is created at the cursor. Also on the ribbon (🍴) and in the editor's right-click / long-press menu. |
| **Adjust food at cursor** | Change the quantity or unit of the row your cursor is on; calories and macros recalculate. **Different food…** swaps the food. |
| **Remove food at cursor** | Deletes the row and fixes up the totals. |
| **Insert empty food log** | Drops in an empty log table. |
| **Open My foods** | Opens your food database note, creating it if needed. |

When adding or removing rows, Cal Track rewrites the table's formulas the way a spreadsheet would. `=SUM(D1:D3)` becomes `=SUM(D1:D4)`, and `Remaining` keeps pointing at `Total` and `Goal`. If you add or delete rows by hand, re-check the formulas: Table Calc references are positional.

### Barcodes

Type or paste the number under a barcode (UPC-A, EAN-8/13, GTIN-14; spaces and dashes are fine) into the search box. Cal Track looks it up on Open Food Facts and in USDA's branded foods instead of running a text search. A 12- or 13-digit number is looked up as soon as it's complete; press Enter for other lengths. If nothing is found, use **+ Custom** to enter it from the label.

### Units

- **Portions from the database**: `medium`, `slice`, `serving`, `cup`… using the database's own gram weight.
- **Mass**: `g`, `oz`, `lb`, `kg`, `mg`, always available.
- **Volume**: `cup`, `tbsp`, `tsp`, `ml`, `fl oz`, `l`. These are offered only when the database gives a volume portion for that food, so the density is known. Otherwise "1 cup of flour" would just be a guess.

### Food sources

| Source | Good for | Key |
|--------|----------|-----|
| [USDA FoodData Central](https://fdc.nal.usda.gov/) | Generic foods (banana, chicken breast) and US brands | Optional. The shared `DEMO_KEY` allows about 30 lookups an hour; a [free personal key](https://fdc.nal.usda.gov/api-key-signup) gives 1,000. |
| [Open Food Facts](https://world.openfoodfacts.org/) | Packaged foods worldwide | None |
| **My foods** | Your own foods and portions, kept in a note in your vault | — |

Search shows **My foods** first, then recently used foods, then the online results.

### My foods

Your own food database is a normal note, `Cal Track/Foods.md` by default (you can change the path in settings). You can read it, edit it by hand, and it syncs with the rest of your vault:

```markdown
| Food | Per | kcal | Protein | Carbs | Fat | Portions |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Protein bar | 1 bar = 60 g | 240 | 20 | 25 | 8 | |
| Salmon, cooked | 100 g | 206 | 22.1 | 0 | 12.4 | fillet = 154 g; my plate = 6 oz |
| Mom's lasagna | 1 slice | 450 | | | | big slice = 1.5 slice |
```

- **Per** says what the numbers are for: `100 g`, `40 g`, `1 bar = 60 g`, or `1 slice`. With no weight, only slices (and portions defined in slices) can be logged.
- **Portions** are extra units, separated by `;`, each written `name = quantity unit`. A portion can use any unit the food already has.

Ways foods get there:
- **+ Custom** in the search box: type in a nutrition label.
- **Save as portion…** in the quantity picker: name the current amount ("my bowl") and it becomes a unit for that food. This works on online foods too, and saves them to My foods.
- **Save to My foods** in the quantity picker: keeps an online food, so it's found instantly and works offline.
- **Open My foods** command: edit the note directly. Changes apply on the next search.

### Your own tables

Columns are found by their header names, so you can reorder them, drop the macro columns, or add your own (e.g. `Notes`). Cal Track leaves extra columns alone. Recognized headers: `Food`/`Item`, `Qty`/`Amount`, `Unit`, `kcal`/`Calories`, `Protein`, `Carbs`, `Fat`. A table only needs `Food` and `kcal`. Rows whose first cell is `Total`, `Goal` or `Remaining` count as summary rows.

---

## Settings

- **USDA / Open Food Facts**: turn each source on or off; USDA API key
- **Macro columns**: include Protein / Carbs / Fat in new logs
- **Daily calorie goal**: adds Goal and Remaining rows to new logs
- **My foods note**: where your food database lives
- **Clear recent foods**: forgets cached lookups (My foods is untouched)

---

## Installation (manual)

1. Install and enable **Table Calc**.
2. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
3. Copy them into `<vault>/.obsidian/plugins/cal-track/`.
4. **Settings → Community plugins** → reload → enable **Cal Track**.

## Development

```bash
npm install
npm run build   # → main.js
npm test        # units, parsers, table editing
npm run lint
```

The database parsers are tested against fixtures in the documented USDA and Open Food Facts response formats (`test/food.test.js`).

## Disclaimer

Nutrition data comes from public databases and user-entered labels and can be wrong or incomplete. Cal Track is for personal tracking, not medical or dietary advice.

## License

MIT
