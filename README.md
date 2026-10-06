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

When adding or removing rows, Cal Track rewrites the table's formulas the way a spreadsheet would. `=SUM(D1:D3)` becomes `=SUM(D1:D4)`, and `Remaining` keeps pointing at `Total` and `Goal`. If you add or delete rows by hand, re-check the formulas: Table Calc references are positional.

### Units

- **Portions from the database**: `medium`, `slice`, `serving`, `cup`… using the database's own gram weight.
- **Mass**: `g`, `oz`, `lb`, `kg`, `mg`, always available.
- **Volume**: `cup`, `tbsp`, `tsp`, `ml`, `fl oz`, `l`. These are offered only when the database gives a volume portion for that food, so the density is known. Otherwise "1 cup of flour" would just be a guess.

### Food sources

| Source | Good for | Key |
|--------|----------|-----|
| [USDA FoodData Central](https://fdc.nal.usda.gov/) | Generic foods (banana, chicken breast) and US brands | Optional. The shared `DEMO_KEY` allows about 30 lookups an hour; a [free personal key](https://fdc.nal.usda.gov/api-key-signup) gives 1,000. |
| [Open Food Facts](https://world.openfoodfacts.org/) | Packaged foods worldwide | None |
| **Custom** | Anything with a nutrition label | — |

Every food you log is saved locally. It shows up instantly (and offline) under **Saved & recent** next time, and lets **Adjust** recalculate without a network call.

### Your own tables

Columns are found by their header names, so you can reorder them, drop the macro columns, or add your own (e.g. `Notes`). Cal Track leaves extra columns alone. Recognized headers: `Food`/`Item`, `Qty`/`Amount`, `Unit`, `kcal`/`Calories`, `Protein`, `Carbs`, `Fat`. A table only needs `Food` and `kcal`. Rows whose first cell is `Total`, `Goal` or `Remaining` count as summary rows.

---

## Settings

- **USDA / Open Food Facts**: turn each source on or off; USDA API key
- **Macro columns**: include Protein / Carbs / Fat in new logs
- **Daily calorie goal**: adds Goal and Remaining rows to new logs
- **Clear saved foods**

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
