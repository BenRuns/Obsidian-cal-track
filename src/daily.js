// Daily notes: where today's note is, the date a note is for, and filling in
// its template — matching what the Periodic Notes plugin or Obsidian's core
// Daily notes plugin would do. Kept free of Obsidian imports so it can be
// tested in Node; dates are moment objects passed in by the caller.

/** @typedef {import('moment').Moment} Moment */
/** @typedef {import('moment').unitOfTime.DurationConstructor} DurationUnit */
/** @typedef {import('./types').DailyConfig} DailyConfig */
/** @typedef {import('./types').DailyNoteOptions} DailyNoteOptions */
/** @typedef {import('./types').PeriodicNotesSettings} PeriodicNotesSettings */

const DEFAULT_FORMAT = 'YYYY-MM-DD';
// The date column in the food log.
const DATE_KEY = 'YYYY-MM-DD';

/**
 * @param {DailyNoteOptions} config
 * @returns {DailyConfig}
 */
function clean(config) {
  return {
    format: config.format || DEFAULT_FORMAT,
    folder: (config.folder || '').trim().replace(/^\/+|\/+$/g, ''),
    template: (config.template || config.templatePath || '').trim(),
  };
}

// Where the user's daily-note settings live, in order of preference:
//   - Periodic Notes 0.x: settings.daily = { enabled, format, folder, template }
//   - Periodic Notes 1.x: settings.calendarSets[].day = { enabled, format, folder, templatePath }
//   - core Daily notes: { format, folder, template }
// Returns null when daily notes aren't turned on anywhere.
/**
 * @param {{ periodicNotes?: PeriodicNotesSettings | null, coreDailyNotes?: DailyNoteOptions | null }} [sources]
 * @returns {DailyConfig | null}
 */
function dailyConfig({ periodicNotes, coreDailyNotes } = {}) {
  if (periodicNotes) {
    if (periodicNotes.daily?.enabled) return clean(periodicNotes.daily);
    const sets = periodicNotes.calendarSets;
    if (Array.isArray(sets)) {
      const set = sets.find((s) => s.id === periodicNotes.activeCalendarSet) || sets[0];
      if (set?.day?.enabled) return clean(set.day);
    }
  }
  if (coreDailyNotes) return clean(coreDailyNotes);
  return null;
}

/**
 * @param {Pick<DailyConfig, 'folder' | 'format'>} config
 * @param {Moment} date
 */
function notePath({ folder, format }, date) {
  const name = `${date.format(format)}.md`;
  return folder ? `${folder}/${name}` : name;
}

// The date a note is the daily note for, as a moment, or null.
// parse(text, format) is a strict moment parse.
/**
 * @param {Pick<DailyConfig, 'folder' | 'format'>} config
 * @param {string} path
 * @param {(text: string, format: string) => Moment} parse
 * @returns {Moment | null}
 */
function dateOfNote({ folder, format }, path, parse) {
  if (!path.endsWith('.md')) return null;
  const prefix = folder ? `${folder}/` : '';
  if (!path.startsWith(prefix)) return null;
  const date = parse(path.slice(prefix.length, -3), format);
  return date.isValid() ? date : null;
}

// The same placeholders Periodic Notes fills in when it creates a daily note:
// {{date}}, {{title}}, {{time}}, {{date:FMT}}, {{date+1d:FMT}}, {{yesterday}}
// and {{tomorrow}}. Templater syntax is left alone for Templater to handle.
/**
 * @param {string} text
 * @param {{ format: string, date: Moment, now: Moment }} options
 */
function fillTemplate(text, { format, date, now }) {
  const title = date.format(format);
  return text
    .replace(/{{\s*date\s*}}/gi, title)
    .replace(/{{\s*time\s*}}/gi, now.format('HH:mm'))
    .replace(/{{\s*title\s*}}/gi, title)
    .replace(
      /{{\s*(date|time)\s*(([+-]\d+)([yqmwdhs]))?\s*(:.+?)?}}/gi,
      /**
       * @param {string} _
       * @param {string} _kind
       * @param {string | undefined} calc
       * @param {string} delta
       * @param {DurationUnit} unit
       * @param {string | undefined} fmt
       */
      (_, _kind, calc, delta, unit, fmt) => {
        const d = date
          .clone()
          .set({ hour: now.get('hour'), minute: now.get('minute'), second: now.get('second') });
        if (calc) d.add(Number.parseInt(delta, 10), unit);
        return fmt ? d.format(fmt.slice(1).trim()) : d.format(format);
      },
    )
    .replace(/{{\s*yesterday\s*}}/gi, date.clone().subtract(1, 'day').format(format))
    .replace(/{{\s*tomorrow\s*}}/gi, date.clone().add(1, 'day').format(format));
}

const LOG_BLOCK = '```cal-track\n```';

/** @param {string} text */
function hasLogBlock(text) {
  return /^\s*```+\s*cal-track\b/m.test(text);
}

// Adds an (empty) cal-track block at the end of a note.
/** @param {string} text */
function withLogBlock(text) {
  const body = text.replace(/\s+$/, '');
  return `${body ? `${body}\n\n` : ''}${LOG_BLOCK}\n`;
}

export { DATE_KEY, dailyConfig, dateOfNote, fillTemplate, hasLogBlock, notePath, withLogBlock };
