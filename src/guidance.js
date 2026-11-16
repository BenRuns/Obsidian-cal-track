// Day guidance from other plugins. Any enabled plugin can expose
// `api.calTrackDay(date)` returning `{ noDeficit?: boolean, note?: string }`
// (or a promise of one, or null). Cal Track doesn't know or care which plugins
// do: on a no-deficit day it uses your maintenance calories as the goal, and
// it shows each note under the day's food table. A provider asks open logs to
// re-render with `app.workspace.trigger('cal-track:refresh')`.

/** Workspace event a provider triggers when its guidance changes. */
const REFRESH_EVENT = 'cal-track:refresh';

/** @typedef {{ noDeficit: boolean, notes: string[] }} DayGuidance */

/**
 * Check what another plugin handed back, so a bad value can't break the log.
 * @param {unknown} value
 * @returns {{ noDeficit: boolean, note: string } | null}
 */
function asGuidance(value) {
  if (!value || typeof value !== 'object') return null;
  const g = /** @type {Record<string, unknown>} */ (value);
  const noDeficit = g.noDeficit === true;
  const note = typeof g.note === 'string' ? g.note.trim() : '';
  return noDeficit || note ? { noDeficit, note } : null;
}

/**
 * Ask every provider about a day. A provider that throws, hangs past
 * `timeoutMs` or returns junk is skipped.
 * @param {Array<(date: string) => unknown>} providers
 * @param {string} date YYYY-MM-DD
 * @param {number} [timeoutMs]
 * @returns {Promise<DayGuidance>}
 */
async function guidanceFor(providers, date, timeoutMs = 2000) {
  const answers = await Promise.all(
    providers.map(async (provider) => {
      /** @type {number | undefined} */
      let timer;
      try {
        const late = new Promise((resolve) => {
          timer = window.setTimeout(() => resolve(null), timeoutMs);
        });
        return asGuidance(await Promise.race([provider(date), late]));
      } catch {
        return null;
      } finally {
        window.clearTimeout(timer);
      }
    }),
  );
  const found = answers.filter((a) => a !== null);
  return {
    noDeficit: found.some((a) => a.noDeficit),
    notes: found.map((a) => a.note).filter(Boolean),
  };
}

/**
 * The day's goal: your daily goal, or maintenance calories on a no-deficit
 * day. Never lower than the daily goal.
 * @param {number} dailyGoal kcal; 0 = none
 * @param {number} maintenance kcal; 0 = not set
 * @param {DayGuidance | null} guidance
 * @returns {{ goal: number, maintain: boolean }}
 */
function goalFor(dailyGoal, maintenance, guidance) {
  const maintain = !!guidance?.noDeficit && maintenance > 0;
  return { goal: maintain ? Math.max(dailyGoal, maintenance) : dailyGoal, maintain };
}

export { asGuidance, goalFor, guidanceFor, REFRESH_EVENT };
