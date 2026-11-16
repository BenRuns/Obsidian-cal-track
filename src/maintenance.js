// An estimate of maintenance calories before exercise, from your own log:
// average intake less average active calories over recent logged days,
// corrected for any weight change. It matches how the goal is used: on a
// no-deficit day, Remaining adds the day's active calories back on top.

/** Days ending yesterday that the estimate looks at. */
const WINDOW_DAYS = 28;
/** Logged days needed in the window for an estimate. */
const MIN_DAYS = 14;
/** Rule-of-thumb energy in a unit of body weight. */
const KCAL_PER = { kg: 7700, lb: 3500 };

/**
 * @typedef {{ kcal: number, active: number }} LoggedDay
 * @typedef {{ maintenance: number, days: number, intake: number, active: number, adjust: number }} Estimate
 */

/**
 * @param {LoggedDay[]} days one per day with food logged, within the window
 * @param {{ weightChange?: number, unit?: 'kg' | 'lb', windowDays?: number }} [options]
 *   weightChange: gained (+) or lost (−) over the window
 * @returns {Estimate | null} null with fewer than MIN_DAYS logged days
 */
function estimateMaintenance(
  days,
  { weightChange = 0, unit = 'kg', windowDays = WINDOW_DAYS } = {},
) {
  if (days.length < MIN_DAYS) return null;
  const mean = (/** @type {number[]} */ xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const intake = mean(days.map((d) => d.kcal));
  const active = mean(days.map((d) => d.active));
  // Weight lost means you ate below maintenance, so maintenance is higher.
  const change = Number.isFinite(weightChange) ? weightChange : 0;
  const adjust = change ? (-change * KCAL_PER[unit]) / windowDays : 0;
  return {
    maintenance: Math.max(0, Math.round((intake - active + adjust) / 10) * 10),
    days: days.length,
    intake: Math.round(intake),
    active: Math.round(active),
    adjust: Math.round(adjust) || 0,
  };
}

export { estimateMaintenance, MIN_DAYS, WINDOW_DAYS };
