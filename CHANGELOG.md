# Changelog

## 0.1.0

First release.

- **Food lookup** from USDA FoodData Central and Open Food Facts, searched on Enter. Barcode (UPC / EAN) lookup runs as soon as the number is complete, with a clear message when no product is found.
- **Quantity, unit and meal picker:** database portions, mass units, and volume units when the density is known. Meals are Breakfast, Lunch, Dinner and Snack by default, configurable, and guessed from the time of day.
- **Food log in a CSV file** (`Cal Track/log.csv`), one row per food, which you can open in a spreadsheet.
- **Daily notes** (Periodic Notes or core Daily notes) show that day's foods in a `cal-track` block: grouped by meal with subtotals, Total / Goal / Remaining, and buttons to add, adjust or remove foods. Today's note is created from your template when needed.
- **Add food to today** and **Open today's food log** commands; adding from the command or ribbon opens today's note.
- **My foods:** your own food database as an editable note (`Cal Track/Foods.md`), searched first. Custom foods from a nutrition label, saved portions ("my bowl = 300 g"), and saving online foods for offline use.
- **Combos:** several foods saved as one, e.g. a usual breakfast or a recipe with several servings, logged as a single row and editable later.
- **Lookups are cached,** and a rate-limited source is backed off automatically.
- **USDA lookups retry automatically,** with exponential backoff (up to 3 times), when FoodData Central has a momentary server error or dropped connection.
- **USDA API key** stored in Obsidian's keychain on Obsidian 1.11.4+, with a link to the free signup.
