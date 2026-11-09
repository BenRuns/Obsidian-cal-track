// Exercise: calories burned in a day's activities, read from activity notes'
// properties (as Physical Activity Importer writes them). Only activities
// with an estimate from heart rate or power count: estimated_calories (all
// burned during it) and active_calories (burned above resting, which is what
// to add back to a daily goal, since the goal already covers resting burn).
// The day is the local date of the note's start_date. Kept free of Obsidian
// imports so it can be tested in Node.

/** @typedef {{ path: string, frontmatter?: Record<string, unknown> | null }} NoteProperties */
/** @typedef {{ path: string, name: string, kcal: number, active: number }} Activity */
/** @typedef {{ kcal: number, active: number, activities: Activity[] }} Exercise */

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toNumber(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

// The note's estimated and active calories, or null if it has no estimate.
/**
 * @param {Record<string, unknown> | null | undefined} frontmatter
 * @returns {{ kcal: number, active: number } | null}
 */
function calorieEstimate(frontmatter) {
  if (!frontmatter) return null;
  const kcal = toNumber(frontmatter.estimated_calories);
  const active = toNumber(frontmatter.active_calories);
  return kcal === null || active === null ? null : { kcal, active };
}

// dayOf turns a start_date into a local YYYY-MM-DD, or null.
/**
 * @param {NoteProperties[]} notes
 * @param {string} date YYYY-MM-DD
 * @param {(startDate: unknown) => string | null} dayOf
 * @returns {Exercise}
 */
function exerciseFor(notes, date, dayOf) {
  /** @type {Activity[]} */
  const activities = [];
  for (const { path, frontmatter } of notes) {
    const estimate = calorieEstimate(frontmatter);
    if (!estimate || !frontmatter || dayOf(frontmatter.start_date) !== date) continue;
    const name = typeof frontmatter.name === 'string' && frontmatter.name ? frontmatter.name : '';
    activities.push({
      path,
      name: name || path.replace(/^.*\//, '').replace(/\.md$/, ''),
      ...estimate,
    });
  }
  activities.sort((a, b) => a.path.localeCompare(b.path));
  return {
    kcal: activities.reduce((sum, a) => sum + a.kcal, 0),
    active: activities.reduce((sum, a) => sum + a.active, 0),
    activities,
  };
}

export { calorieEstimate, exerciseFor };
