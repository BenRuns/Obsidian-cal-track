'use strict';

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  MarkdownView,
  Notice,
  TFile,
  normalizePath,
  requestUrl,
} = require('obsidian');
const { searchAll, getUsdaFood, asBarcode } = require('./api');
const { displayName, nutrientsFor, makeCustomFood } = require('./food');
const { toGrams, unitsFor, normalizeUnit } = require('./units');
const { parseFoodFile, upsertFood, withPortion, newFileLines } = require('./foodfile');
const {
  findTables,
  tableAt,
  readFoodRow,
  insertFoodRow,
  updateFoodRow,
  deleteFoodRow,
  buildTable,
  formatNumber,
} = require('./table');

// ─── Settings ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  usdaApiKey: '', // blank → DEMO_KEY (30 requests/hour per IP)
  useUsda: true,
  useOff: true,
  macros: true, // include Protein / Carbs / Fat columns in new tables
  dailyGoal: 0, // kcal; 0 = no Goal / Remaining rows
  foodsFile: 'Cal Track/Foods.md', // your own food database, a note in the vault
};

const MAX_RECENT = 30;
const MAX_SAVED = 300;

class CalTrackSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveAll();
    containerEl.empty();

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Food logs are Table Calc tables — install and enable Table Calc to see the totals evaluated.',
    });

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

    new Setting(containerEl)
      .setName('USDA API key')
      .setDesc(
        'Optional. Without one the shared DEMO_KEY is used (about 30 lookups an hour). ' +
          'Get a free key at fdc.nal.usda.gov/api-key-signup.',
      )
      .addText((t) =>
        t
          .setPlaceholder('DEMO_KEY')
          .setValue(s.usdaApiKey)
          .onChange(async (v) => {
            s.usdaApiKey = v.trim();
            await save();
          }),
      );

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

    new Setting(containerEl).setName('New food logs').setHeading();

    new Setting(containerEl)
      .setName('Macro columns')
      .setDesc('Include Protein, Carbs and Fat columns.')
      .addToggle((t) =>
        t.setValue(s.macros).onChange(async (v) => {
          s.macros = v;
          await save();
        }),
      );

    new Setting(containerEl)
      .setName('Daily calorie goal')
      .setDesc('Adds Goal and Remaining rows. Leave at 0 for none.')
      .addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s.dailyGoal || 0)).onChange(async (v) => {
          const n = Number(v);
          s.dailyGoal = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
          await save();
        });
      });

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
  constructor(plugin, { query = '', onChoose }) {
    super(plugin.app);
    this.plugin = plugin;
    this.query = query;
    this.onChoose = onChoose;
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
    this.input.addEventListener('input', () => this.schedule(400));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.schedule(0);
      }
    });
    const custom = row.createEl('button', { text: '+ Custom' });
    custom.title = 'Enter a food from its nutrition label';
    custom.addEventListener('click', () => {
      this.close();
      new CustomFoodModal(this.plugin, {
        name: this.input.value,
        onSave: (food) => this.onChoose(food),
      }).open();
    });

    this.status = contentEl.createDiv({ cls: 'cal-track-status' });
    this.list = contentEl.createDiv({ cls: 'cal-track-results' });

    this.mine = [];
    this.renderLocal();
    this.plugin.getMyFoods().then((foods) => {
      this.mine = foods;
      if (this.list) this.renderLocal();
    });
    if (this.query.trim().length >= 2) this.schedule(0);
    window.setTimeout(() => this.input.focus(), 0);
  }

  onClose() {
    window.clearTimeout(this.timer);
    this.searchSeq++;
    this.contentEl.empty();
  }

  schedule(delay) {
    window.clearTimeout(this.timer);
    this.renderLocal();
    // While a barcode is being typed, don't look up every prefix: wait for a
    // full UPC-A / EAN-13, or Enter (delay 0) for the other lengths.
    const digits = this.input.value.replace(/[\s-]/g, '');
    if (delay > 0 && /^\d+$/.test(digits) && digits.length !== 12 && digits.length !== 13) {
      this.searchSeq++;
      this.status.setText(digits.length >= 8 ? 'Press Enter to look up this barcode.' : '');
      return;
    }
    this.timer = window.setTimeout(() => this.search(), delay);
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
    const { foods, errors, barcode } = await searchAll(requestUrl, q, s);
    if (seq !== this.searchSeq) return; // superseded by newer typing / closed
    this.renderLocal();
    const none = barcode
      ? `No product found for barcode ${barcode}. Use + Custom to add it from the label.`
      : 'No matches.';
    this.status.setText(errors.length ? errors.join(' · ') : foods.length ? '' : none);
    if (foods.length) {
      this.list.createDiv({
        cls: 'cal-track-section',
        text: barcode ? `Barcode ${barcode}` : 'Search results',
      });
      for (const f of foods) this.renderItem(f);
    }
  }

  renderItem(food) {
    const item = this.list.createDiv({ cls: 'cal-track-item' });
    const main = item.createDiv({ cls: 'cal-track-item-main' });
    main.createSpan({ cls: 'cal-track-item-name', text: food.name });
    if (food.brand) main.createSpan({ cls: 'cal-track-item-brand', text: food.brand });
    const meta = item.createDiv({ cls: 'cal-track-item-meta' });
    const kcal = formatNumber(food.per100g.kcal, 0);
    meta.createSpan({ text: food.noMass ? `${kcal} kcal / serving` : `${kcal} kcal / 100 g` });
    meta.createSpan({ cls: 'cal-track-badge', text: SOURCE_LABELS[food.source] || food.source });
    item.addEventListener('click', () => this.choose(food));
  }

  async choose(food) {
    let chosen = food;
    // Search hits without household portions only offer g/oz; the full record
    // usually has "1 medium", "1 cup", etc.
    if (food.source === 'usda' && food.portions.length === 0) {
      this.status.setText('Loading portions…');
      try {
        const full = await getUsdaFood(
          requestUrl,
          food.id.slice(5),
          this.plugin.settings.usdaApiKey,
        );
        if (full.per100g.kcal !== null) chosen = { ...food, portions: full.portions };
      } catch (_) {
        /* fall back to mass units only */
      }
    }
    this.close();
    this.onChoose(chosen);
  }
}

class PortionModal extends Modal {
  constructor(plugin, food, { qty = 1, unit, submitText = 'Add', onSubmit, onChangeFood }) {
    super(plugin.app);
    this.plugin = plugin;
    this.food = food;
    this.qty = qty;
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
    if (this.food.source !== 'local') {
      const keepBtn = links.createEl('button', { cls: 'cal-track-link', text: 'Save to My foods' });
      keepBtn.addEventListener('click', async () => {
        await this.adoptSaved(await this.plugin.saveMyFood(this.food));
        keepBtn.remove();
        new Notice(`Saved ${displayName(this.food)} to My foods`);
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
    this.onSubmit({ qty: Number(this.qty), unit: this.unit, grams, nutrients, food: this.food });
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
      text: 'Copy the numbers from the nutrition label. Saved to My foods for next time.',
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

// ─── Plugin ───────────────────────────────────────────────────────────────────

class CalTrackPlugin extends Plugin {
  async onload() {
    await this.loadAll();
    this.addSettingTab(new CalTrackSettingTab(this.app, this));

    this.addRibbonIcon('utensils', 'Add food to log', () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) {
        new Notice('Open a note to add food.');
        return;
      }
      this.addFood(view.editor);
    });

    this.addCommand({
      id: 'add-food',
      name: 'Add food to log',
      icon: 'utensils',
      editorCallback: (editor) => this.addFood(editor),
    });

    this.addCommand({
      id: 'adjust-food',
      name: 'Adjust food at cursor (quantity, unit)',
      editorCheckCallback: (checking, editor) => {
        const hit = this.foodRowAtCursor(editor);
        if (!hit) return false;
        if (!checking) this.adjustFood(editor, hit);
        return true;
      },
    });

    this.addCommand({
      id: 'remove-food',
      name: 'Remove food at cursor',
      editorCheckCallback: (checking, editor) => {
        const hit = this.foodRowAtCursor(editor);
        if (!hit) return false;
        if (!checking) this.removeFood(editor, hit);
        return true;
      },
    });

    this.addCommand({
      id: 'open-my-foods',
      name: 'Open My foods',
      callback: () => this.openMyFoods(),
    });

    // Hand edits to My foods take effect on the next search.
    const invalidate = (file) => {
      if (file?.path === this.foodsPath()) this.myFoods = null;
    };
    this.registerEvent(this.app.vault.on('modify', invalidate));
    this.registerEvent(this.app.vault.on('delete', invalidate));
    this.registerEvent(this.app.vault.on('create', invalidate));
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file.path === this.foodsPath() || oldPath === this.foodsPath()) this.myFoods = null;
      }),
    );

    this.addCommand({
      id: 'insert-log',
      name: 'Insert empty food log',
      editorCallback: (editor) => {
        this.insertBlockAtCursor(editor, buildTable(this.tableOptions()));
      },
    });

    // Long-press / right-click menu — the easiest way in on mobile.
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        const hit = this.foodRowAtCursor(editor);
        if (hit) {
          menu.addItem((i) =>
            i
              .setTitle('Adjust food')
              .setIcon('pencil')
              .onClick(() => this.adjustFood(editor, hit)),
          );
          menu.addItem((i) =>
            i
              .setTitle('Remove food')
              .setIcon('trash')
              .onClick(() => this.removeFood(editor, hit)),
          );
        }
        menu.addItem((i) =>
          i
            .setTitle('Add food')
            .setIcon('utensils')
            .onClick(() => this.addFood(editor)),
        );
      }),
    );
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
        const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (folder && !this.app.vault.getAbstractFileByPath(folder))
          await this.app.vault.createFolder(folder);
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

  async openMyFoods() {
    const path = this.foodsPath();
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (folder && !this.app.vault.getAbstractFileByPath(folder))
        await this.app.vault.createFolder(folder);
      file = await this.app.vault.create(path, `${newFileLines().join('\n')}\n`);
    }
    await this.app.workspace.getLeaf(true).openFile(file);
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

  tableOptions() {
    return { macros: this.settings.macros, goal: this.settings.dailyGoal };
  }

  // ── Editor helpers ──

  lines(editor) {
    return editor.getValue().split('\n');
  }

  applyEdit(editor, edit) {
    const last = editor.getLine(edit.to);
    editor.replaceRange(
      edit.lines.join('\n'),
      { line: edit.from, ch: 0 },
      { line: edit.to, ch: last.length },
    );
  }

  insertBlockAtCursor(editor, block) {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    // Tables need a blank line above them to render.
    if (line.trim() === '') {
      editor.replaceRange(`${block.join('\n')}\n`, { line: cursor.line, ch: 0 });
    } else {
      editor.replaceRange(`\n\n${block.join('\n')}\n`, { line: cursor.line, ch: line.length });
    }
  }

  foodRowAtCursor(editor) {
    const lines = this.lines(editor);
    const lineNo = editor.getCursor().line;
    const table = tableAt(lines, lineNo);
    if (!table) return null;
    const row = readFoodRow(lines, table, lineNo);
    return row ? { lineNo, row } : null;
  }

  rowValues(food, { qty, unit, nutrients }) {
    return { food: displayName(food), qty, unit, ...nutrients };
  }

  // ── Actions ──

  pickFood({ query, onFood }) {
    new FoodSearchModal(this, {
      query,
      onChoose: async (food) => {
        await this.rememberFood(food);
        onFood(food);
      },
    }).open();
  }

  addFood(editor) {
    this.pickFood({
      onFood: (food) =>
        this.askPortion(food, {
          submitText: 'Add',
          onSubmit: (p) => this.insertFood(editor, food, p),
        }),
    });
  }

  askPortion(food, opts) {
    const unit = opts.unit || (food.portions[0]?.unit ?? 'g');
    const qty = opts.qty ?? (normalizeUnit(unit) === 'g' ? 100 : 1);
    new PortionModal(this, food, { ...opts, unit, qty }).open();
  }

  insertFood(editor, food, portion) {
    const values = this.rowValues(food, portion);
    const lines = this.lines(editor);
    const cursorLine = editor.getCursor().line;
    // Prefer the table the cursor is in, then the first log in the note.
    const table = tableAt(lines, cursorLine) || findTables(lines)[0];
    if (table) {
      this.applyEdit(editor, insertFoodRow(lines, table, values));
    } else {
      const block = buildTable(this.tableOptions());
      const [t] = findTables(block);
      // The edit covers the table rows only; keep the {{calc}} line above them.
      const edit = insertFoodRow(block, t, values);
      this.insertBlockAtCursor(editor, [...block.slice(0, edit.from), ...edit.lines]);
    }
  }

  async adjustFood(editor, { lineNo, row }) {
    const replace = (food, portion) => {
      // Re-resolve the row: the note may have changed while the modal was open.
      const lines = this.lines(editor);
      const table = tableAt(lines, lineNo);
      if (!table || !readFoodRow(lines, table, lineNo)) {
        new Notice('That food row moved — put the cursor on it and try again.');
        return;
      }
      this.applyEdit(editor, updateFoodRow(lines, table, lineNo, this.rowValues(food, portion)));
    };
    const search = () =>
      this.pickFood({
        query: row.name,
        onFood: (food) =>
          this.askPortion(food, {
            qty: Number(row.qty) || undefined,
            unit: row.unit,
            submitText: 'Update',
            onSubmit: (p) => replace(food, p),
          }),
      });

    const food = await this.findFood(row.name);
    if (!food) {
      // Typed by hand or recent foods were cleared — look it up again.
      search();
      return;
    }
    this.askPortion(food, {
      qty: Number(row.qty) || undefined,
      unit: row.unit,
      submitText: 'Update',
      onSubmit: (p) => replace(food, p),
      onChangeFood: search,
    });
  }

  removeFood(editor, { lineNo }) {
    const lines = this.lines(editor);
    const table = tableAt(lines, lineNo);
    if (!table) return;
    this.applyEdit(editor, deleteFoodRow(lines, table, lineNo));
  }
}

module.exports = CalTrackPlugin;
