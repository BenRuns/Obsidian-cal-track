import {
  MarkdownRenderChild,
  Modal,
  moment,
  Notice,
  normalizePath,
  Plugin,
  PluginSettingTab,
  requestUrl,
  // Obsidian 1.11.4+; undefined on older versions, which keep the key in data.json.
  SecretComponent,
  Setting,
  setIcon,
  TFile,
} from 'obsidian';
import { asBarcode, getUsdaFood } from './api.js';
import { TTLCache } from './cache.js';
import { makeCombo } from './combo.js';
import {
  DATE_KEY,
  dailyConfig,
  dateOfNote,
  fillTemplate,
  hasLogBlock,
  notePath,
  withLogBlock,
} from './daily.js';
import { displayName, makeCustomFood, nutrientsFor } from './food.js';
import { newFileLines, parseFoodFile, removeFood, upsertFood, withPortion } from './foodfile.js';
import {
  appendEntry,
  DECIMALS,
  entriesFor,
  groupByMeal,
  mealForTime,
  newId,
  parseLog,
  parseMeals,
  removeEntry,
  totals,
  updateEntry,
} from './logcsv.js';
import { cachedSearch, RATE_LIMIT_COOLDOWN_MS } from './lookup.js';
import { formatNumber } from './table.js';
import { normalizeUnit, toGrams, unitsFor } from './units.js';

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  usdaApiKey: '', // plain-text key, for Obsidian without SecretStorage; blank → DEMO_KEY
  usdaKeySecret: '', // name of the secret holding the key in Obsidian's keychain (1.11.4+)
  useUsda: true,
  useOff: true,
  macros: true, // show Protein / Carbs / Fat columns in daily logs
  dailyGoal: 0, // kcal; 0 = no Goal / Remaining rows
  foodsFile: 'Cal Track/Foods.md', // your own food database, a note in the vault
  logFile: 'Cal Track/log.csv', // the food log: one row per food eaten
  meals: 'Breakfast, Lunch, Dinner, Snack', // offered when logging; blank = no meal labels
};

const today = () => moment().format(DATE_KEY);

const USDA_SIGNUP_URL = 'https://fdc.nal.usda.gov/api-key-signup';

// The keychain name used when moving a plain-text key over.
const USDA_SECRET = 'cal-track-usda-api-key';

const MAX_RECENT = 30;
const MAX_SAVED = 300;

class CalTrackSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // In Obsidian's keychain when it has one (Settings → Keychain), so the key
  // isn't sitting in data.json; otherwise a plain text field as before.
  usdaKeySetting(containerEl) {
    const s = this.plugin.settings;
    const save = () => this.plugin.saveAll();
    // A DEMO_KEY cooldown doesn't apply to a newly-added personal key.
    const keyChanged = () => delete this.plugin.rateLimitCooldowns.USDA;
    // Description with a clickable signup link, plus any extra sentences.
    const about = (...extra) =>
      createFragment((f) => {
        f.appendText(
          'Optional. Without one the shared DEMO_KEY is used, which allows only about 10 lookups an hour. ',
        );
        f.createEl('a', { text: 'Get a free key', href: USDA_SIGNUP_URL });
        f.appendText(' — it takes about a minute.');
        for (const text of extra) f.appendText(` ${text}`);
      });
    const setting = new Setting(containerEl).setName('USDA API key');

    if (!this.plugin.hasKeychain()) {
      setting.setDesc(about()).addText((t) =>
        t
          .setPlaceholder('DEMO_KEY')
          .setValue(s.usdaApiKey)
          .onChange(async (v) => {
            s.usdaApiKey = v.trim();
            keyChanged();
            await save();
          }),
      );
      return;
    }

    const missing = s.usdaKeySecret && !this.plugin.app.secretStorage.getSecret(s.usdaKeySecret);
    setting
      .setDesc(
        about(
          "Kept in Obsidian's keychain on this device, not synced: set it once on each device.",
          ...(missing ? [`The secret "${s.usdaKeySecret}" isn't set on this device yet.`] : []),
        ),
      )
      .addComponent((el) =>
        new SecretComponent(this.app, el).setValue(s.usdaKeySecret).onChange(async (name) => {
          s.usdaKeySecret = name;
          // The key now lives in the keychain; don't leave a copy in data.json.
          if (name) s.usdaApiKey = '';
          keyChanged();
          await save();
          this.display();
        }),
      );

    // A key saved before the keychain existed: move it, one click.
    if (s.usdaApiKey && !s.usdaKeySecret) {
      new Setting(containerEl)
        .setName('Move your key to the keychain')
        .setDesc(
          "Your USDA key is saved in plain text in this vault's data.json. Moving it removes it " +
            'from data.json, so other devices need it set in their own keychain.',
        )
        .addButton((b) =>
          b
            .setButtonText('Move')
            .setCta()
            .onClick(async () => {
              this.plugin.app.secretStorage.setSecret(USDA_SECRET, s.usdaApiKey);
              s.usdaKeySecret = USDA_SECRET;
              s.usdaApiKey = '';
              await save();
              this.display();
            }),
        );
    }
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveAll();
    containerEl.empty();

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'Everything you eat is kept in one CSV file, a row per food. Each daily note shows ' +
        "that day's foods and totals in a cal-track block, added for you the first time you log.",
    });

    new Setting(containerEl).setName('Food log').setHeading();

    const config = this.plugin.dailyConfig();
    new Setting(containerEl)
      .setName('Daily notes')
      .setDesc(
        config
          ? `Today's note: ${notePath(config, moment())}. Folder, date format and template come ` +
              'from your Periodic Notes or Daily notes settings.'
          : "Not set up. Turn on daily notes in the Periodic Notes plugin or Obsidian's core daily notes plugin. Cal Track logs into daily notes.",
      );

    new Setting(containerEl)
      .setName('Food log file')
      .setDesc(
        'A CSV file you can also open in a spreadsheet. Columns: id, date, time, food, qty, unit, kcal, protein, carbs, fat.',
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.logFile)
          .setValue(s.logFile)
          .onChange(async (v) => {
            s.logFile = v.trim() || DEFAULT_SETTINGS.logFile;
            await save();
            this.plugin.logChanged();
          }),
      );

    new Setting(containerEl).setName('Food databases').setHeading();

    new Setting(containerEl)
      .setName('USDA FoodData Central')
      .setDesc('Best for generic foods (banana, chicken breast) and many US brands.')
      .addToggle((t) =>
        t.setValue(s.useUsda).onChange(async (v) => {
          s.useUsda = v;
          await save();
        }),
      );

    this.usdaKeySetting(containerEl);

    new Setting(containerEl)
      .setName('Open Food Facts')
      .setDesc('Crowd-sourced packaged foods from around the world. No key needed.')
      .addToggle((t) =>
        t.setValue(s.useOff).onChange(async (v) => {
          s.useOff = v;
          await save();
        }),
      );

    new Setting(containerEl).setName('My foods').setHeading();

    new Setting(containerEl)
      .setName('My foods note')
      .setDesc(
        'Custom foods and saved portions live in this note, searched before the online databases. ' +
          'It is a normal table you can edit by hand.',
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.foodsFile)
          .setValue(s.foodsFile)
          .onChange(async (v) => {
            s.foodsFile = v.trim() || DEFAULT_SETTINGS.foodsFile;
            this.plugin.myFoods = null;
            await save();
          }),
      )
      .addButton((b) => b.setButtonText('Open').onClick(() => this.plugin.openMyFoods()));

    new Setting(containerEl).setName('Daily log').setHeading();

    new Setting(containerEl)
      .setName('Macro columns')
      .setDesc('Show protein, carbs and fat columns.')
      .addToggle((t) =>
        t.setValue(s.macros).onChange(async (v) => {
          s.macros = v;
          await save();
          this.plugin.logChanged();
        }),
      );

    new Setting(containerEl)
      .setName('Daily calorie goal')
      .setDesc('Adds goal and remaining rows. Leave at 0 for none.')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.dailyGoal || 0)).onChange(async (v) => {
          const n = Number(v);
          s.dailyGoal = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
          await save();
          this.plugin.logChanged();
        });
      });

    new Setting(containerEl)
      .setName('Meals')
      .setDesc(
        'Labels you can give each food, separated by commas, in the order the daily log shows them. ' +
          'Leave blank to log without meals.',
      )
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.meals)
          .setValue(s.meals)
          .onChange(async (v) => {
            s.meals = v;
            await save();
            this.plugin.logChanged();
          }),
      );

    new Setting(containerEl).setName('Recent foods').setHeading();

    new Setting(containerEl)
      .setName('Clear recent foods')
      .setDesc(
        `${Object.keys(this.plugin.foods).length} looked-up foods are remembered so they can be ` +
          're-added and adjusted without a network lookup. My foods are not affected.',
      )
      .addButton((b) =>
        b
          .setButtonText('Clear')
          .setWarning()
          .onClick(async () => {
            this.plugin.foods = {};
            this.plugin.recent = [];
            await save();
            this.display();
          }),
      );
  }
}

// ─── Modals ───────────────────────────────────────────────────────────────────

function summarize(n, grams) {
  const parts = [`${formatNumber(n.kcal, 0) || '?'} kcal`];
  if (n.protein !== null) parts.push(`P ${formatNumber(n.protein, 1)} g`);
  if (n.carbs !== null) parts.push(`C ${formatNumber(n.carbs, 1)} g`);
  if (n.fat !== null) parts.push(`F ${formatNumber(n.fat, 1)} g`);
  return grams === null
    ? parts.join(' · ')
    : `${parts.join(' · ')}  (≈ ${formatNumber(grams, 0)} g)`;
}

const SOURCE_LABELS = { usda: 'USDA', off: 'OFF', custom: 'Mine', local: 'Mine' };

class FoodSearchModal extends Modal {
  constructor(plugin, { query = '', onChoose, allowCombo = true }) {
    super(plugin.app);
    this.plugin = plugin;
    this.query = query;
    this.onChoose = onChoose;
    this.allowCombo = allowCombo;
    this.searchSeq = 0;
    this.timer = null;
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText('Look up food');
    contentEl.addClass('cal-track-search');

    const row = contentEl.createDiv({ cls: 'cal-track-search-row' });
    this.input = row.createEl('input', {
      type: 'search',
      placeholder: 'Food name or barcode (UPC)',
      value: this.query,
    });
    this.input.addEventListener('input', () => this.onType());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.search();
      }
    });
    const searchBtn = row.createEl('button', { cls: 'mod-cta', text: 'Search' });
    searchBtn.addEventListener('click', () => this.search());
    const custom = row.createEl('button', { text: 'Custom food' });
    custom.title = 'Enter a food from its nutrition label';
    custom.addEventListener('click', () => this.addCustom());
    if (this.allowCombo) {
      const combo = row.createEl('button', { text: 'New combo' });
      combo.title = 'Save several foods as one, such as your usual breakfast or a recipe';
      combo.addEventListener('click', () => {
        this.close();
        new ComboModal(this.plugin, { onSave: (food) => this.onChoose(food) }).open();
      });
    }

    this.status = contentEl.createDiv({ cls: 'cal-track-status' });
    this.list = contentEl.createDiv({ cls: 'cal-track-results' });

    this.mine = [];
    this.renderLocal();
    this.plugin.getMyFoods().then((foods) => {
      this.mine = foods;
      if (this.list) this.renderLocal();
    });
    if (this.query.trim().length >= 2) this.search();
    window.setTimeout(() => this.input.focus(), 0);
  }

  onClose() {
    window.clearTimeout(this.timer);
    this.searchSeq++;
    this.contentEl.empty();
  }

  // Typing filters My foods and Recent only. Online searches run on Enter or
  // the Search button: Open Food Facts allows 10 searches a minute and asks
  // apps not to search as you type, and USDA's DEMO_KEY allows about 10 an hour.
  onType() {
    window.clearTimeout(this.timer);
    this.searchSeq++; // results for the old text no longer apply
    this.renderLocal();
    const q = this.input.value.trim();
    const { useUsda, useOff } = this.plugin.settings;
    // A complete UPC-A / EAN-13 is a single product lookup, not a search, so
    // it runs as soon as the number is in.
    if (/^\d{12,13}$/.test(q.replace(/[\s-]/g, ''))) {
      this.timer = window.setTimeout(() => this.search(), 300);
      return;
    }
    let hint = '';
    if (q.length >= 2 && (useUsda || useOff))
      hint = asBarcode(q)
        ? 'Press Enter to look up this barcode.'
        : 'Press Enter to search online.';
    this.status.setText(hint);
  }

  // My foods first (all matches), then recently looked-up foods that aren't
  // also in My foods.
  renderLocal() {
    this.list.empty();
    const q = this.input.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const match = (f) => words.every((w) => displayName(f).toLowerCase().includes(w));
    const mine = this.mine.filter(match);
    const mineKeys = new Set(this.mine.map((f) => displayName(f).toLowerCase()));
    const recent = this.plugin
      .savedFoods()
      .filter((f) => match(f) && !mineKeys.has(displayName(f).toLowerCase()))
      .slice(0, q ? 6 : 10);
    if (mine.length) {
      this.list.createDiv({ cls: 'cal-track-section', text: 'My foods' });
      for (const f of mine) this.renderItem(f);
    }
    if (recent.length) {
      this.list.createDiv({ cls: 'cal-track-section', text: 'Recent' });
      for (const f of recent) this.renderItem(f);
    }
  }

  async search() {
    window.clearTimeout(this.timer);
    const q = this.input.value.trim();
    if (q.length < 2) {
      this.status.setText('');
      return;
    }
    const s = this.plugin.settings;
    if (!s.useUsda && !s.useOff) {
      this.status.setText('Both online databases are off in settings — only your foods are shown.');
      return;
    }
    const seq = ++this.searchSeq;
    this.status.setText(asBarcode(q) ? 'Looking up barcode…' : 'Searching…');
    const { foods, errors, barcode } = await this.plugin.lookupFoods(q);
    if (seq !== this.searchSeq) return; // superseded by newer typing / search, or closed
    this.renderLocal();
    if (barcode && !foods.length) {
      this.status.setText('');
      this.renderBarcodeMiss(barcode, errors);
      return;
    }
    this.status.setText(errors.length ? errors.join(' · ') : foods.length ? '' : 'No matches.');
    if (foods.length) {
      this.list.createDiv({
        cls: 'cal-track-section',
        text: barcode ? `Barcode ${barcode}` : 'Search results',
      });
      for (const f of foods) this.renderItem(f);
    }
  }

  // A barcode with no product: say plainly what was checked, what couldn't
  // be (and why), and offer to enter the food from its label.
  renderBarcodeMiss(barcode, errors) {
    const { useUsda, useOff } = this.plugin.settings;
    const enabled = [useUsda && 'USDA', useOff && 'Open Food Facts'].filter(Boolean);
    const failed = enabled.filter((src) => errors.some((e) => e.startsWith(`${src}:`)));
    const checked = enabled.filter((src) => !failed.includes(src));

    const box = this.list.createDiv({ cls: 'cal-track-miss' });
    this.list.prepend(box); // above My foods / Recent
    box.createDiv({
      cls: 'cal-track-miss-title',
      text: checked.length
        ? `No product found for barcode ${barcode}`
        : `Couldn't look up barcode ${barcode}`,
    });
    if (checked.length) box.createDiv({ text: `Not in ${checked.join(' or ')}.` });
    for (const e of errors) box.createDiv({ cls: 'cal-track-miss-error', text: e });
    box.createDiv({
      text: checked.length
        ? 'Check the number, or add the food from its nutrition label.'
        : 'Try again in a few minutes, or add the food from its nutrition label.',
    });
    const add = box.createEl('button', { cls: 'mod-cta', text: 'Add from label' });
    add.addEventListener('click', () => this.addCustom());
  }

  // A barcode isn't a food name, so the label form starts blank for one.
  addCustom() {
    const typed = this.input.value.trim();
    this.close();
    new CustomFoodModal(this.plugin, {
      name: asBarcode(typed) ? '' : typed,
      onSave: (food) => this.onChoose(food),
    }).open();
  }

  renderItem(food) {
    const item = this.list.createDiv({ cls: 'cal-track-item' });
    const main = item.createDiv({ cls: 'cal-track-item-main' });
    main.createSpan({ cls: 'cal-track-item-name', text: food.name });
    if (food.brand) main.createSpan({ cls: 'cal-track-item-brand', text: food.brand });
    const meta = item.createDiv({ cls: 'cal-track-item-meta' });
    const kcal = formatNumber(food.per100g.kcal, 0);
    meta.createSpan({ text: food.noMass ? `${kcal} kcal / serving` : `${kcal} kcal / 100 g` });
    meta.createSpan({
      cls: 'cal-track-badge',
      text: food.ingredients?.length ? 'Combo' : SOURCE_LABELS[food.source] || food.source,
    });
    item.addEventListener('click', () => this.choose(food));
  }

  async choose(food) {
    // Search hits without household portions only offer g/oz; the full record
    // usually has "1 medium", "1 cup", etc. getFullPortions() is a no-op for
    // anything that doesn't need it, so only show a status message when this
    // will actually hit the network (not cached from a previous lookup).
    const willFetch =
      food.source === 'usda' &&
      food.portions.length === 0 &&
      !this.plugin.portionCache.get(food.id);
    if (willFetch) this.status.setText('Loading portions…');
    const portions = await this.plugin.getFullPortions(food);
    const chosen = portions.length ? { ...food, portions } : food;
    this.close();
    this.onChoose(chosen);
  }
}

class PortionModal extends Modal {
  constructor(plugin, food, opts) {
    const {
      qty = 1,
      unit,
      meal = '',
      meals = [],
      submitText = 'Add',
      onSubmit,
      onChangeFood,
    } = opts;
    super(plugin.app);
    this.plugin = plugin;
    this.opts = opts;
    this.food = food;
    this.qty = qty;
    // Match the setting's spelling ("breakfast" typed by hand → "Breakfast"), and
    // keep a meal that's no longer in the setting so editing a food doesn't drop it.
    const known = meal && meals.find((m) => m.toLowerCase() === meal.toLowerCase());
    this.meal = known || meal;
    this.meals = meal && !known ? [...meals, meal] : meals;
    this.units = unitsFor(food);
    const wanted = normalizeUnit(unit);
    this.unit = this.units.includes(wanted) ? wanted : this.units[0];
    this.submitText = submitText;
    this.onSubmit = onSubmit;
    this.onChangeFood = onChangeFood;
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(displayName(this.food));
    contentEl.addClass('cal-track-portion');

    const row = contentEl.createDiv({ cls: 'cal-track-portion-row' });
    const qty = row.createEl('input', { type: 'number', value: String(this.qty) });
    qty.setAttr('step', 'any');
    qty.setAttr('min', '0');
    qty.setAttr('inputmode', 'decimal');
    qty.addEventListener('input', () => {
      this.qty = qty.value;
      this.update();
    });
    qty.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      }
    });

    const select = row.createEl('select', { cls: 'dropdown' });
    for (const u of this.units) select.createEl('option', { value: u, text: u });
    select.value = this.unit;
    select.addEventListener('change', () => {
      this.unit = select.value;
      this.update();
    });

    this.select = select;
    if (this.meals.length) {
      const mealSelect = row.createEl('select', { cls: 'dropdown cal-track-meal' });
      mealSelect.createEl('option', { value: '', text: 'No meal' });
      for (const m of this.meals) mealSelect.createEl('option', { value: m, text: m });
      mealSelect.value = this.meal;
      mealSelect.addEventListener('change', () => {
        this.meal = mealSelect.value;
      });
    }
    this.preview = contentEl.createDiv({ cls: 'cal-track-preview' });
    this.renderSaveRow(contentEl);

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    if (this.onChangeFood) {
      buttons.createEl('button', { text: 'Different food…' }).addEventListener('click', () => {
        this.close();
        this.onChangeFood();
      });
    }
    this.submitBtn = buttons.createEl('button', { cls: 'mod-cta', text: this.submitText });
    this.submitBtn.addEventListener('click', () => this.submit());

    this.update();
    window.setTimeout(() => qty.select(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }

  // "Save as portion…" stores the current amount under a name ("my bowl")
  // on this food in My foods; "Save to My foods" keeps an online food there.
  renderSaveRow(contentEl) {
    const wrap = contentEl.createDiv({ cls: 'cal-track-save' });
    const links = wrap.createDiv({ cls: 'cal-track-save-links' });
    const form = wrap.createDiv({ cls: 'cal-track-save-form' });
    form.hide();

    const portionBtn = links.createEl('button', {
      cls: 'cal-track-link',
      text: 'Save as portion…',
    });
    portionBtn.title = 'Name this amount (e.g. "my bowl") so you can pick it as a unit next time';
    portionBtn.addEventListener('click', () => {
      form.show();
      name.focus();
    });
    if (this.food.ingredients?.length) {
      const editBtn = links.createEl('button', { cls: 'cal-track-link', text: 'Edit combo…' });
      editBtn.addEventListener('click', () => {
        this.close();
        new ComboModal(this.plugin, {
          combo: this.food,
          // Back to this picker, for the edited combo.
          onSave: (food) => this.plugin.askPortion(food, this.opts),
        }).open();
      });
    }
    if (this.food.source !== 'local') {
      const keepBtn = links.createEl('button', { cls: 'cal-track-link', text: 'Save to my foods' });
      keepBtn.addEventListener('click', async () => {
        await this.adoptSaved(await this.plugin.saveMyFood(this.food));
        keepBtn.remove();
        new Notice(`Saved ${displayName(this.food)} to my foods`);
      });
    }

    const name = form.createEl('input', {
      type: 'text',
      placeholder: 'Portion name, e.g. my bowl',
    });
    const save = form.createEl('button', { cls: 'mod-cta', text: 'Save' });
    const doSave = async () => {
      const label = name.value.trim();
      const updated = label && withPortion(this.food, label, this.qty, this.unit);
      if (!updated) {
        new Notice('Enter a name and a quantity first.');
        return;
      }
      await this.adoptSaved(await this.plugin.saveMyFood(updated));
      this.qty = 1;
      this.unit = normalizeUnit(label);
      this.refreshUnits();
      name.value = '';
      form.hide();
      new Notice(`Saved "${this.unit}" for ${displayName(this.food)}`);
    };
    save.addEventListener('click', doSave);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doSave();
      }
    });
  }

  // Switch to the My foods copy so later saves update that row.
  async adoptSaved(saved) {
    if (saved) this.food = saved;
    this.units = unitsFor(this.food);
  }

  refreshUnits() {
    this.select.empty();
    for (const u of this.units) this.select.createEl('option', { value: u, text: u });
    this.select.value = this.units.includes(this.unit) ? this.unit : this.units[0];
    this.unit = this.select.value;
    const qty = this.contentEl.querySelector('.cal-track-portion-row input');
    if (qty) qty.value = String(this.qty);
    this.update();
  }

  compute() {
    const grams = toGrams(this.food, this.qty, this.unit);
    return { grams, nutrients: nutrientsFor(this.food, grams) };
  }

  update() {
    const { grams, nutrients } = this.compute();
    const ok = grams !== null && Number(this.qty) > 0;
    this.preview.setText(
      ok ? summarize(nutrients, this.food.noMass ? null : grams) : 'Enter a quantity',
    );
    this.submitBtn.disabled = !ok;
  }

  submit() {
    const { grams, nutrients } = this.compute();
    if (grams === null || !(Number(this.qty) > 0)) return;
    this.close();
    this.onSubmit({
      qty: Number(this.qty),
      unit: this.unit,
      meal: this.meal,
      grams,
      nutrients,
      food: this.food,
    });
  }
}

class CustomFoodModal extends Modal {
  constructor(plugin, { name = '', onSave }) {
    super(plugin.app);
    this.plugin = plugin;
    this.values = { name, servingAmount: '1', servingUnit: 'serving', servingGrams: '' };
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText('Custom food');
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Copy the numbers from the nutrition label. Saved to my foods for next time.',
    });

    const field = (name, key, opts = {}) =>
      new Setting(contentEl)
        .setName(name)
        .setDesc(opts.desc || '')
        .addText((t) => {
          if (opts.number) {
            t.inputEl.type = 'number';
            t.inputEl.setAttr('step', 'any');
            t.inputEl.setAttr('inputmode', 'decimal');
          }
          t.setPlaceholder(opts.placeholder || '')
            .setValue(this.values[key] || '')
            .onChange((v) => {
              this.values[key] = v;
            });
        });

    field('Name', 'name', { placeholder: 'Protein bar' });
    field('Serving amount', 'servingAmount', { number: true });
    field('Serving unit', 'servingUnit', { placeholder: 'serving, bar, g, cup…' });
    field('Serving weight (g)', 'servingGrams', {
      number: true,
      desc: 'Optional, but lets you log it in grams or ounces too.',
    });
    field('Calories (kcal)', 'kcal', { number: true });
    field('Protein (g)', 'protein', { number: true });
    field('Carbs (g)', 'carbs', { number: true });
    field('Fat (g)', 'fat', { number: true });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText('Save')
        .setCta()
        .onClick(() => {
          const v = this.values;
          if (
            !v.name?.trim() ||
            v.kcal === undefined ||
            v.kcal === '' ||
            !Number.isFinite(Number(v.kcal))
          ) {
            new Notice('A name and calories are required.');
            return;
          }
          this.close();
          this.plugin.saveMyFood(makeCustomFood(v)).then((food) => this.onSave(food));
        }),
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Several foods saved as one My foods entry: your usual breakfast, or a recipe
// that makes several servings. Logged as a single row (see combo.js).
class ComboModal extends Modal {
  constructor(plugin, { combo = null, onSave }) {
    super(plugin.app);
    this.plugin = plugin;
    this.original = combo;
    this.name = combo?.name ?? '';
    this.servings = combo?.servings ?? 1;
    // { food, qty, unit, grams, nutrients }, or { missing: { name, qty, unit } }
    // for an ingredient that can't be found any more.
    this.items = [];
    this.onSave = onSave;
  }

  async onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(this.original ? 'Edit combo' : 'New combo');
    contentEl.addClass('cal-track-combo');
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: "Several foods saved as one. It's added to my foods and logged as a single row.",
    });

    new Setting(contentEl).setName('Name').addText((t) =>
      t
        .setPlaceholder('My usual breakfast')
        .setValue(this.name)
        .onChange((v) => {
          this.name = v;
        }),
    );
    new Setting(contentEl)
      .setName('Servings')
      .setDesc(
        'How many servings this makes: 1 for a single meal, or more for a recipe, like 6 for a pot of chili.',
      )
      .addText((t) => {
        t.inputEl.type = 'number';
        t.inputEl.setAttr('min', '1');
        t.inputEl.setAttr('step', 'any');
        t.setValue(String(this.servings)).onChange((v) => {
          this.servings = Number(v);
          this.renderTotals();
        });
      });

    this.listEl = contentEl.createDiv({ cls: 'cal-track-combo-items' });
    const add = contentEl.createEl('button', { text: 'Add food' });
    add.addEventListener('click', () => this.pick());
    this.totalsEl = contentEl.createDiv({ cls: 'cal-track-preview' });

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    buttons
      .createEl('button', { cls: 'mod-cta', text: 'Save' })
      .addEventListener('click', () => this.save());

    if (this.original) await this.loadIngredients();
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  item(food, qty, unit, grams) {
    return { food, qty, unit, grams, nutrients: nutrientsFor(food, grams) };
  }

  async loadIngredients() {
    for (const ing of this.original.ingredients) {
      const food = await this.plugin.findFood(ing.name);
      const grams = food ? toGrams(food, ing.qty, ing.unit) : null;
      this.items.push(grams > 0 ? this.item(food, ing.qty, ing.unit, grams) : { missing: ing });
    }
  }

  // Add a food (index undefined), or replace the one at index.
  pick(index, query) {
    this.plugin.pickFood({
      query,
      allowCombo: false,
      onFood: (food) => this.askAmount(food, index),
    });
  }

  askAmount(food, index, current) {
    this.plugin.askPortion(food, {
      qty: current?.qty,
      unit: current?.unit,
      submitText: index === undefined ? 'Add' : 'Update',
      onSubmit: (p) => {
        const item = this.item(food, p.qty, p.unit, p.grams);
        if (index === undefined) this.items.push(item);
        else this.items[index] = item;
        this.render();
      },
    });
  }

  render() {
    this.listEl.empty();
    if (!this.items.length) {
      this.listEl.createDiv({ cls: 'cal-track-empty', text: 'No foods yet.' });
    }
    this.items.forEach((it, i) => {
      const row = this.listEl.createDiv({ cls: 'cal-track-combo-item' });
      const main = row.createDiv({ cls: 'cal-track-item-main' });
      if (it.missing) {
        main.createSpan({ text: it.missing.name });
        main.createSpan({
          cls: 'cal-track-miss-error',
          text: `${formatNumber(it.missing.qty, 2)} ${it.missing.unit} — not found, look it up again`,
        });
        iconButton(row, 'search', 'Look up again', () => this.pick(i, it.missing.name));
      } else {
        main.createSpan({ text: displayName(it.food) });
        main.createSpan({
          cls: 'cal-track-item-brand',
          text: `${formatNumber(it.qty, 2)} ${it.unit} · ${formatNumber(it.nutrients.kcal, 0)} kcal`,
        });
        iconButton(row, 'pencil', 'Change amount', () => this.askAmount(it.food, i, it));
      }
      iconButton(row, 'trash', 'Remove', () => {
        this.items.splice(i, 1);
        this.render();
      });
    });
    this.renderTotals();
  }

  combo() {
    const found = this.items.filter((it) => !it.missing);
    return makeCombo({
      name: this.name.trim() || 'Combo',
      items: found.map((it) => ({ ...it, name: displayName(it.food) })),
      servings: this.servings,
    });
  }

  renderTotals() {
    const food = this.combo();
    if (!food) {
      this.totalsEl.setText('');
      return;
    }
    const grams = toGrams(food, 1, 'serving');
    const text = summarize(nutrientsFor(food, grams), food.noMass ? null : grams);
    this.totalsEl.setText(food.servings !== 1 ? `Per serving: ${text}` : text);
  }

  async save() {
    const name = this.name.trim();
    if (!name) {
      new Notice('Give the combo a name.');
      return;
    }
    if (this.items.some((it) => it.missing)) {
      new Notice("Look up or remove the foods that weren't found first.");
      return;
    }
    const food = this.combo();
    if (!food) {
      new Notice('Add at least one food with calories.');
      return;
    }
    const key = name.toLowerCase();
    const renamed = this.original && this.original.name.toLowerCase() !== key;
    if (!this.original || renamed) {
      const mine = await this.plugin.getMyFoods();
      if (mine.some((f) => displayName(f).toLowerCase() === key)) {
        new Notice(`My foods already has "${name}". Pick another name.`);
        return;
      }
    }
    this.close();
    if (renamed) await this.plugin.removeMyFood(this.original.name);
    const saved = await this.plugin.saveMyFood(food);
    new Notice(`Saved ${name} to my foods`);
    this.onSave?.(saved);
  }
}

// ─── Daily log block ──────────────────────────────────────────────────────────

const LABELS = { kcal: 'kcal', protein: 'Protein', carbs: 'Carbs', fat: 'Fat' };

function iconButton(parent, icon, label, onClick) {
  const b = parent.createEl('button', {
    cls: 'clickable-icon cal-track-icon',
    attr: { 'aria-label': label },
  });
  setIcon(b, icon);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

// A ```cal-track``` block in a daily note: that day's rows from the food log,
// with totals, re-rendered whenever the log changes.
class DailyLogView extends MarkdownRenderChild {
  constructor(plugin, el, date) {
    super(el);
    this.plugin = plugin;
    this.date = date; // YYYY-MM-DD
    this.seq = 0;
  }

  onload() {
    this.plugin.views.add(this);
    this.render();
  }

  onunload() {
    this.plugin.views.delete(this);
  }

  async render() {
    const seq = ++this.seq;
    const entries = entriesFor(await this.plugin.getLog(), this.date);
    if (seq !== this.seq) return; // a newer render started while this one read the log
    const { macros, dailyGoal } = this.plugin.settings;
    const keys = macros ? ['kcal', 'protein', 'carbs', 'fat'] : ['kcal'];
    const el = this.containerEl;
    el.empty();
    el.addClass('cal-track-log');

    const table = el.createEl('table');
    const head = table.createEl('thead').createEl('tr');
    head.createEl('th', { text: 'Food' });
    head.createEl('th', { text: 'Qty' });
    for (const k of keys) head.createEl('th', { text: LABELS[k], cls: 'cal-track-num' });
    head.createEl('th');

    const body = table.createEl('tbody');
    const meals = this.plugin.mealList();
    // Grouped under meal headings with subtotals once any food has a meal.
    const groups = entries.some((e) => e.meal)
      ? groupByMeal(entries, meals)
      : [{ meal: null, entries }];
    for (const group of groups) {
      if (group.meal !== null) this.renderMealRow(body, group, keys, meals);
      for (const e of group.entries) this.renderEntry(body, e, keys);
    }
    if (!entries.length) {
      body.createEl('tr').createEl('td', {
        text: 'Nothing logged yet.',
        cls: 'cal-track-empty',
        attr: { colspan: keys.length + 3 },
      });
    }

    const foot = table.createEl('tfoot');
    const sum = totals(entries);
    const summary = (label, values) => {
      const tr = foot.createEl('tr');
      tr.createEl('th', { text: label });
      tr.createEl('td');
      for (const k of keys) tr.createEl('td', { text: values[k] ?? '', cls: 'cal-track-num' });
      tr.createEl('td');
    };
    summary(
      'Total',
      Object.fromEntries(keys.map((k) => [k, formatNumber(sum[k] ?? 0, DECIMALS[k])])),
    );
    if (dailyGoal > 0) {
      summary('Goal', { kcal: String(dailyGoal) });
      summary('Remaining', { kcal: formatNumber(dailyGoal - (sum.kcal ?? 0), 0) });
    }

    const add = el.createEl('button', { text: 'Add food', cls: 'cal-track-add' });
    setIcon(add.createSpan({ cls: 'cal-track-add-icon' }), 'plus');
    add.addEventListener('click', () => this.plugin.addFood(this.date));
  }

  renderMealRow(body, { meal, entries }, keys, meals) {
    const tr = body.createEl('tr', { cls: 'cal-track-meal-row' });
    tr.createEl('th', { text: meal || 'No meal', attr: { colspan: 2 } });
    const sum = totals(entries);
    for (const k of keys)
      tr.createEl('td', { text: formatNumber(sum[k] ?? 0, DECIMALS[k]), cls: 'cal-track-num' });
    const actions = tr.createEl('td', { cls: 'cal-track-actions' });
    if (meal && meals.includes(meal))
      iconButton(actions, 'plus', `Add to ${meal}`, () => this.plugin.addFood(this.date, meal));
  }

  renderEntry(body, e, keys) {
    const tr = body.createEl('tr');
    tr.createEl('td', { text: e.food });
    tr.createEl('td', { text: `${formatNumber(e.qty, 2)} ${e.unit}`.trim() });
    for (const k of keys)
      tr.createEl('td', { text: formatNumber(e[k], DECIMALS[k]), cls: 'cal-track-num' });
    const actions = tr.createEl('td', { cls: 'cal-track-actions' });
    iconButton(actions, 'pencil', 'Adjust', () => this.plugin.adjustEntry(e));
    iconButton(actions, 'trash', 'Remove', () => this.plugin.removeLogEntry(e));
  }
}

function blockMessage(el, text) {
  el.createDiv({ cls: 'cal-track-log cal-track-empty', text });
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class CalTrackPlugin extends Plugin {
  async onload() {
    await this.loadAll();
    // In-memory only — cleared on reload. They only ever save a network
    // call, never hold data of their own, so nothing is lost by that.
    this.searchCache = new TTLCache({ ttlMs: 10 * 60 * 1000, maxEntries: 60 });
    this.portionCache = new TTLCache({ ttlMs: 60 * 60 * 1000, maxEntries: 60 });
    this.rateLimitCooldowns = {};
    this.views = new Set();
    this.addSettingTab(new CalTrackSettingTab(this.app, this));

    // From the command or ribbon, logging ends on today's note so you see it.
    this.addRibbonIcon('utensils', 'Add food to today', () =>
      this.addFood(today(), undefined, { open: true }),
    );

    this.addCommand({
      id: 'add-food',
      name: 'Add food to today',
      icon: 'utensils',
      callback: () => this.addFood(today(), undefined, { open: true }),
    });

    this.addCommand({
      id: 'open-today',
      name: "Open today's food log",
      icon: 'calendar',
      callback: () => this.openDailyNote(today()),
    });

    this.addCommand({
      id: 'new-combo',
      name: 'New combo (several foods as one)',
      callback: () => new ComboModal(this, {}).open(),
    });

    this.addCommand({
      id: 'open-my-foods',
      name: 'Open my foods',
      callback: () => this.openMyFoods(),
    });

    // The block's date: a `date: YYYY-MM-DD` line in it, else the daily note it's in.
    this.registerMarkdownCodeBlockProcessor('cal-track', (source, el, ctx) => {
      const given = source.match(/^\s*date:\s*(\S+)/m)?.[1];
      let date = given ? moment(given, DATE_KEY, true) : null;
      if (!date) {
        const config = this.dailyConfig();
        if (!config) {
          blockMessage(
            el,
            "Cal Track: turn on daily notes (Periodic Notes or Obsidian's Daily notes) to see this day's food log.",
          );
          return;
        }
        date = dateOfNote(config, ctx.sourcePath, (text, format) => moment(text, format, true));
      }
      if (!date?.isValid()) {
        blockMessage(
          el,
          'Cal Track: this block shows a day\'s food log. Put it in a daily note, or add a line like "date: 2026-10-15".',
        );
        return;
      }
      ctx.addChild(new DailyLogView(this, el, date.format(DATE_KEY)));
    });

    // Hand edits to My foods take effect on the next search; changes to the
    // food log (hand edits, sync) show up in every open daily log right away.
    const onChange = (file, oldPath) => {
      const paths = [file?.path, oldPath];
      if (paths.includes(this.foodsPath())) this.myFoods = null;
      if (paths.includes(this.logPath())) this.logChanged();
    };
    this.registerEvent(this.app.vault.on('modify', onChange));
    this.registerEvent(this.app.vault.on('delete', onChange));
    this.registerEvent(this.app.vault.on('create', onChange));
    this.registerEvent(this.app.vault.on('rename', onChange));
  }

  // ── Persistence ──

  async loadAll() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
    this.foods = data.foods || {};
    this.recent = data.recent || [];
  }

  async saveAll() {
    await this.saveData({ settings: this.settings, foods: this.foods, recent: this.recent });
  }

  // ── Food lookups (cached, rate-limit aware — see lookup.js) ──

  hasKeychain() {
    return Boolean(SecretComponent && this.app.secretStorage);
  }

  // The keychain secret when one is chosen, else the plain-text key; '' → DEMO_KEY.
  usdaKey() {
    const name = this.settings.usdaKeySecret;
    if (name && this.hasKeychain()) return this.app.secretStorage.getSecret(name) || '';
    return this.settings.usdaApiKey || '';
  }

  async lookupFoods(query) {
    return cachedSearch({
      request: requestUrl,
      cache: this.searchCache,
      cooldowns: this.rateLimitCooldowns,
      settings: { ...this.settings, usdaApiKey: this.usdaKey() },
      query,
    });
  }

  // A USDA search hit without household portions ("1 medium", "1 cup") needs
  // one more request for the full record, which usually has them. Cached per
  // food id — it's the same answer every time, so there's no reason to pay
  // for that extra request twice.
  async getFullPortions(food) {
    if (food.source !== 'usda' || food.portions.length) return food.portions;
    const cached = this.portionCache.get(food.id);
    if (cached) return cached;
    try {
      const full = await getUsdaFood(requestUrl, food.id.slice(5), this.usdaKey());
      if (full.per100g.kcal === null) return food.portions;
      this.portionCache.set(food.id, full.portions);
      return full.portions;
    } catch (e) {
      if (e?.code === 'rate_limited')
        this.rateLimitCooldowns.USDA = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      return food.portions; // fall back to mass units only
    }
  }

  // Foods are keyed by the name written into the table, so a row can be
  // matched back to its nutrition data when it's adjusted later.
  async rememberFood(food) {
    const key = displayName(food).toLowerCase();
    this.foods[key] = food;
    this.recent = [key, ...this.recent.filter((k) => k !== key)].slice(0, MAX_RECENT);
    const keys = Object.keys(this.foods);
    if (keys.length > MAX_SAVED) {
      const keep = new Set(this.recent);
      for (const k of keys) {
        if (Object.keys(this.foods).length <= MAX_SAVED) break;
        if (!keep.has(k)) delete this.foods[k];
      }
    }
    await this.saveAll();
  }

  // ── My foods (a note in the vault) ──

  foodsPath() {
    return normalizePath(this.settings.foodsFile || DEFAULT_SETTINGS.foodsFile);
  }

  async getMyFoods() {
    if (this.myFoods) return this.myFoods;
    const file = this.app.vault.getAbstractFileByPath(this.foodsPath());
    this.myFoods =
      file instanceof TFile ? parseFoodFile(await this.app.vault.cachedRead(file)) : [];
    return this.myFoods;
  }

  // Writes the food into My foods (adding or replacing its row) and returns
  // the copy as read back from the note.
  async saveMyFood(food) {
    const path = this.foodsPath();
    let file = this.app.vault.getAbstractFileByPath(path);
    try {
      if (file instanceof TFile) {
        await this.app.vault.process(file, (text) => upsertFood(text, food));
      } else {
        await this.ensureFolderFor(path);
        file = await this.app.vault.create(path, upsertFood('', food));
      }
    } catch (e) {
      new Notice(`Couldn't save to ${path}: ${e.message}`);
      return food;
    }
    this.myFoods = null;
    const key = displayName(food).toLowerCase();
    const saved =
      (await this.getMyFoods()).find((f) => displayName(f).toLowerCase() === key) || food;
    await this.rememberFood(saved);
    return saved;
  }

  async removeMyFood(name) {
    const file = this.app.vault.getAbstractFileByPath(this.foodsPath());
    if (!(file instanceof TFile)) return;
    await this.app.vault.process(file, (text) => removeFood(text, name));
    this.myFoods = null;
  }

  async openMyFoods() {
    const path = this.foodsPath();
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      await this.ensureFolderFor(path);
      file = await this.app.vault.create(path, `${newFileLines().join('\n')}\n`);
    }
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  async ensureFolderFor(path) {
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (folder && !this.app.vault.getAbstractFileByPath(folder))
      await this.app.vault.createFolder(folder);
  }

  // ── Food log (a CSV file in the vault) ──

  logPath() {
    return normalizePath(this.settings.logFile || DEFAULT_SETTINGS.logFile);
  }

  async getLog() {
    if (this.log) return this.log;
    const file = this.app.vault.getAbstractFileByPath(this.logPath());
    this.log = file instanceof TFile ? parseLog(await this.app.vault.cachedRead(file)) : [];
    return this.log;
  }

  logChanged() {
    this.log = null;
    for (const view of this.views) view.render();
  }

  // Read-modify-write of the whole file in one step, so two quick edits can't
  // overwrite each other.
  async editLog(change) {
    const path = this.logPath();
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.app.vault.process(file, change);
      } else {
        await this.ensureFolderFor(path);
        await this.app.vault.create(path, change(''));
      }
    } catch (e) {
      new Notice(`Couldn't write ${path}: ${e.message}`);
      return false;
    }
    this.logChanged();
    return true;
  }

  // ── Daily notes (Periodic Notes plugin, or core Daily notes) ──

  dailyConfig() {
    const core = this.app.internalPlugins?.getPluginById?.('daily-notes');
    return dailyConfig({
      // getPlugin only returns enabled plugins.
      periodicNotes: this.app.plugins?.getPlugin?.('periodic-notes')?.settings ?? null,
      coreDailyNotes: core?.enabled ? (core.instance?.options ?? {}) : null,
    });
  }

  async dailyTemplate(config, date) {
    if (!config.template) return '';
    const file = this.app.metadataCache.getFirstLinkpathDest(normalizePath(config.template), '');
    if (!(file instanceof TFile)) {
      new Notice(`Couldn't find your daily note template, ${config.template}.`);
      return '';
    }
    const text = await this.app.vault.cachedRead(file);
    return fillTemplate(text, { format: config.format, date, now: moment() });
  }

  // The daily note for a date, with a cal-track block in it: created from your
  // template if it doesn't exist, the block added if it's missing.
  async ensureDailyNote(dateKey) {
    const config = this.dailyConfig();
    if (!config) return null;
    const date = moment(dateKey, DATE_KEY, true);
    const path = normalizePath(notePath(config, date));
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      if (!hasLogBlock(await this.app.vault.cachedRead(file)))
        await this.app.vault.process(file, withLogBlock);
      return file;
    }
    const text = await this.dailyTemplate(config, date);
    await this.ensureFolderFor(path);
    return this.app.vault.create(path, withLogBlock(text));
  }

  async openDailyNote(dateKey) {
    if (!this.requireDailyNotes()) return;
    try {
      const file = await this.ensureDailyNote(dateKey);
      if (file) await this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      new Notice(`Couldn't open the daily note: ${e.message}`);
    }
  }

  requireDailyNotes() {
    if (this.dailyConfig()) return true;
    new Notice(
      "Cal Track logs into daily notes. Turn them on in the Periodic Notes plugin or Obsidian's core daily notes plugin.",
      8000,
    );
    return false;
  }

  // My foods win over the recent-lookups cache.
  async findFood(name) {
    const key = name.toLowerCase();
    const mine = (await this.getMyFoods()).find((f) => displayName(f).toLowerCase() === key);
    return mine || this.foods[key] || null;
  }

  savedFoods() {
    const recent = this.recent.map((k) => this.foods[k]).filter(Boolean);
    const rest = Object.keys(this.foods)
      .filter((k) => !this.recent.includes(k))
      .map((k) => this.foods[k]);
    return [...recent, ...rest];
  }

  rowValues(food, { qty, unit, nutrients }) {
    return { food: displayName(food), qty, unit, ...nutrients };
  }

  pickFood({ query, onFood, allowCombo }) {
    new FoodSearchModal(this, {
      query,
      allowCombo,
      onChoose: async (food) => {
        await this.rememberFood(food);
        onFood(food);
      },
    }).open();
  }

  askPortion(food, opts) {
    const unit = opts.unit || (food.portions[0]?.unit ?? 'g');
    const qty = opts.qty ?? (normalizeUnit(unit) === 'g' ? 100 : 1);
    new PortionModal(this, food, { ...opts, unit, qty }).open();
  }

  // ── Actions ──

  mealList() {
    return parseMeals(this.settings.meals);
  }

  // meal: preselected in the picker. Without one, today's foods get a guess
  // from the time of day; other days start with no meal.
  // open: show the day's note afterwards (unless it's already the open note).
  addFood(dateKey, meal, { open = false } = {}) {
    if (!this.requireDailyNotes()) return;
    const meals = this.mealList();
    const guess = dateKey === today() ? mealForTime(meals, moment().format('HH:mm')) : '';
    this.pickFood({
      onFood: (food) =>
        this.askPortion(food, {
          meals,
          meal: meal ?? guess,
          submitText: 'Add',
          onSubmit: (p) => this.logFood(dateKey, food, p, { open }),
        }),
    });
  }

  async logFood(dateKey, food, portion, { open = false } = {}) {
    const entry = {
      id: newId(),
      date: dateKey,
      time: moment().format('HH:mm'),
      meal: portion.meal || '',
      ...this.rowValues(food, portion),
    };
    if (!(await this.editLog((text) => appendEntry(text, entry)))) return;
    try {
      const file = await this.ensureDailyNote(dateKey);
      new Notice(`Added ${entry.food} to ${file?.basename ?? dateKey}`);
      if (open && file && this.app.workspace.getActiveFile() !== file)
        await this.app.workspace.getLeaf(false).openFile(file);
    } catch (e) {
      new Notice(`Logged ${entry.food}, but couldn't create the daily note: ${e.message}`);
    }
  }

  async adjustEntry(entry) {
    const replace = (food, portion) =>
      this.editLog((text) =>
        updateEntry(text, entry.id, { ...this.rowValues(food, portion), meal: portion.meal || '' }),
      );
    const opts = {
      qty: entry.qty ?? undefined,
      unit: entry.unit || undefined,
      meal: entry.meal,
      meals: this.mealList(),
      submitText: 'Update',
    };
    const search = () =>
      this.pickFood({
        query: entry.food,
        onFood: (food) => this.askPortion(food, { ...opts, onSubmit: (p) => replace(food, p) }),
      });

    const food = await this.findFood(entry.food);
    if (!food) {
      // Typed by hand or recent foods were cleared — look it up again.
      search();
      return;
    }
    this.askPortion(food, { ...opts, onSubmit: (p) => replace(food, p), onChangeFood: search });
  }

  async removeLogEntry(entry) {
    if (await this.editLog((text) => removeEntry(text, entry.id)))
      new Notice(`Removed ${entry.food}`);
  }
}

export default CalTrackPlugin;
