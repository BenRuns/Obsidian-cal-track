// Training-plan guidance from Marathon Trainer: which days a calorie deficit
// is fine, and which call for eating to maintain (heavy training, the taper,
// carb-loading and race day). Read through Marathon Trainer's public API:
// app.plugins.plugins['marathon-trainer'].api.fuel(date).

/**
 * @typedef {{ date: string, phase: string, fuel: 'deficit-ok' | 'maintain' | 'carb-load' | 'race', note: string }} FuelGuidance
 */

const FUELS = ['deficit-ok', 'maintain', 'carb-load', 'race'];

/**
 * Check what another plugin handed back, so a bad value can't break the log.
 * @param {unknown} value
 * @returns {FuelGuidance | null}
 */
function asGuidance(value) {
  if (!value || typeof value !== 'object') return null;
  const g = /** @type {Record<string, unknown>} */ (value);
  if (typeof g.fuel !== 'string' || !FUELS.includes(g.fuel)) return null;
  return {
    date: typeof g.date === 'string' ? g.date : '',
    phase: typeof g.phase === 'string' ? g.phase : '',
    fuel: /** @type {FuelGuidance['fuel']} */ (g.fuel),
    note: typeof g.note === 'string' ? g.note : '',
  };
}

/**
 * The day's goal: your daily goal, or maintenance calories on days the plan
 * says not to diet. Never lower than the daily goal.
 * @param {number} dailyGoal kcal; 0 = none
 * @param {number} maintenance kcal; 0 = not set
 * @param {FuelGuidance | null} guidance
 * @returns {{ goal: number, maintain: boolean }}
 */
function goalFor(dailyGoal, maintenance, guidance) {
  const maintain = !!guidance && guidance.fuel !== 'deficit-ok' && maintenance > 0;
  return { goal: maintain ? Math.max(dailyGoal, maintenance) : dailyGoal, maintain };
}

export { asGuidance, goalFor };
