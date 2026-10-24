// Shapes shared across the plugin, for type-aware linting only (the plugin is
// plain JavaScript; esbuild ignores this file). Referenced from JSDoc with
// `@typedef {import('./types').Food} Food`.

export type Macro = 'kcal' | 'protein' | 'carbs' | 'fat';

/** kcal and grams of each macro; null when unknown. */
export type Nutrients = Record<Macro, number | null>;

/** "1 medium = 118 g". `def` is how a My foods portion was written ("1.5 slice"). */
export interface Portion {
  unit: string;
  amount: number;
  grams: number;
  def?: string;
}

/** What a custom food's label numbers were for: "1 bar = 60 g". */
export interface Per {
  amount: number;
  unit: string;
  grams: number | null;
}

export interface Ingredient {
  name: string;
  qty: number;
  unit: string;
}

/** The normalized food shape described in food.js. */
export interface Food {
  id: string;
  source: 'usda' | 'off' | 'custom' | 'local';
  name: string;
  brand: string;
  per100g: Nutrients;
  portions: Portion[];
  density?: number;
  noMass?: boolean;
  per?: Per;
  ingredients?: Ingredient[];
  servings?: number;
}

/** One row of the food log CSV. */
export interface LogEntry {
  id: string;
  date: string;
  time: string;
  meal: string;
  food: string;
  qty: number | null;
  unit: string;
  kcal: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

export interface Settings {
  usdaApiKey: string;
  usdaKeySecret: string;
  useUsda: boolean;
  useOff: boolean;
  macros: boolean;
  dailyGoal: number;
  foodsFile: string;
  logFile: string;
  meals: string;
}

/** The settings a search needs; usdaApiKey is the resolved key. */
export type SearchSettings = Pick<Settings, 'useUsda' | 'useOff' | 'usdaApiKey'>;

export interface SearchResult {
  foods: Food[];
  errors: string[];
  barcode: string | null;
  rateLimited: string[];
}

/** Obsidian's requestUrl, or a test stub. */
export type HttpRequest = (req: {
  url: string;
  method: string;
  contentType?: string;
  body?: string;
  headers?: Record<string, string>;
  throw: boolean;
}) => Promise<{ status: number; json: unknown }>;

/** An Error with a machine-readable reason ('rate_limited', 'forbidden', ...). */
export interface HttpError extends Error {
  code?: string;
}

export interface DailyConfig {
  format: string;
  folder: string;
  template: string;
}

/** Daily-note settings as other plugins store them; see dailyConfig() in daily.js. */
export interface DailyNoteOptions {
  enabled?: boolean;
  format?: string;
  folder?: string;
  template?: string;
  templatePath?: string;
}

export interface PeriodicNotesSettings {
  daily?: DailyNoteOptions;
  calendarSets?: { id?: string; day?: DailyNoteOptions }[];
  activeCalendarSet?: string;
}

// ─── Raw API responses (only the fields we read) ─────────────────────────────

export interface UsdaNutrient {
  nutrientId?: number;
  nutrientNumber?: string;
  unitName?: string;
  value?: number;
  amount?: number;
  nutrient?: { id?: number; number?: string; unitName?: string };
}

export interface UsdaFoodJson {
  fdcId: number;
  description?: string;
  brandName?: string;
  brandOwner?: string;
  gtinUpc?: string;
  foodNutrients?: UsdaNutrient[];
  servingSize?: number | string;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  foodMeasures?: { disseminationText?: string; gramWeight?: number }[];
  foodPortions?: {
    amount?: number;
    measureUnit?: { name?: string };
    portionDescription?: string;
    modifier?: string;
    gramWeight?: number;
  }[];
}

export interface UsdaSearchJson {
  foods?: UsdaFoodJson[];
}

export interface OffProductJson {
  code?: string;
  product_name?: string;
  brands?: string | string[];
  nutriments?: Record<string, number | string | undefined>;
  serving_size?: string;
  serving_quantity?: number | string;
}

export interface OffSearchJson {
  products?: OffProductJson[];
}
