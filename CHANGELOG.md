# Changelog

## Unreleased

- **Guidance from other plugins:** other plugins can add a note to a day and mark it as a day not to diet, through `api.calTrackDay(date)`. Set **Maintenance calories** and the goal switches to it on those days, shown as **Goal (maintain)**, never below your daily goal. A training plan can use this so you don't diet through heavy training. Turn **Guidance from other plugins** off in settings to ignore it. See the README for the API.
- **Maintenance calories (before exercise):** **Suggest** estimates it from the last 28 days of your log: average intake less average active workout calories, corrected for any weight change you enter.

## 0.2.0

- **Exercise:** daily logs show the calories burned in that day's activities, from activity notes with `estimated_calories` and `active_calories` properties (as [Physical Activity Importer](https://github.com/BenRuns/physical-activity-importer) writes them), and a **Net** row: what you ate less the active calories. With a goal, Remaining adds back the active calories only, since the goal already covers resting burn. On by default; turn **Exercise** off in settings to hide it.

## 0.1.3

- **Search on phones:** the Look up food search box keeps a usable width; the buttons move to a second line when they don't fit.
- Clears the last warnings from Obsidian's plugin review. No other change in behavior.

## 0.1.2

- **Settings search:** on Obsidian 1.13+, Cal Track's settings show up in Obsidian's settings search. Older versions keep the same settings screen as before.
- Clears the warnings from Obsidian's plugin review. No other change in behavior.

## 0.1.1

- Pass Obsidian's release review: the keychain APIs (Obsidian 1.11.4+) are now guarded with `requireApiVersion`. No change in behavior.

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
