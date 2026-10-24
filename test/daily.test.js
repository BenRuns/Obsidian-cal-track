import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dailyConfig,
  dateOfNote,
  fillTemplate,
  hasLogBlock,
  notePath,
  withLogBlock,
} from '../src/daily.js';

// Just enough of moment for these tests: YYYY MM DD HH mm and [literals], in UTC.
function fakeMoment(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  const m = {
    format(fmt) {
      return fmt.replace(/\[([^\]]*)\]|YYYY|MM|DD|HH|mm/g, (tok, lit) => {
        if (lit !== undefined) return lit;
        return {
          YYYY: d.getUTCFullYear(),
          MM: pad(d.getUTCMonth() + 1),
          DD: pad(d.getUTCDate()),
          HH: pad(d.getUTCHours()),
          mm: pad(d.getUTCMinutes()),
        }[tok];
      });
    },
    clone: () => fakeMoment(d.toISOString()),
    isValid: () => !Number.isNaN(d.getTime()),
    get: (unit) => ({ hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: 0 })[unit],
    set(o) {
      d.setUTCHours(o.hour ?? d.getUTCHours(), o.minute ?? d.getUTCMinutes(), o.second ?? 0);
      return m;
    },
    add(n, unit) {
      if (unit === 'd' || unit === 'day') d.setUTCDate(d.getUTCDate() + n);
      return m;
    },
    subtract: (n, unit) => m.add(-n, unit),
    day(i) {
      d.setUTCDate(d.getUTCDate() - d.getUTCDay() + i);
      return m;
    },
  };
  return m;
}

// A strict parse of YYYY-MM-DD only, enough for dateOfNote.
const parse = (text, format) =>
  fakeMoment(
    format === 'YYYY-MM-DD' && /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : 'x',
  );

test('dailyConfig reads Periodic Notes 0.x settings', () => {
  const periodicNotes = {
    daily: {
      enabled: true,
      format: '',
      folder: ' calendar/daily/ ',
      template: 'templates/daily.md',
    },
  };
  assert.deepEqual(dailyConfig({ periodicNotes }), {
    format: 'YYYY-MM-DD',
    folder: 'calendar/daily',
    template: 'templates/daily.md',
  });
});

test('dailyConfig reads Periodic Notes 1.x calendar sets', () => {
  const periodicNotes = {
    activeCalendarSet: 'b',
    calendarSets: [
      { id: 'a', day: { enabled: true, format: 'DD.MM.YYYY', folder: 'a' } },
      { id: 'b', day: { enabled: true, format: '', folder: 'days', templatePath: 'T/day.md' } },
    ],
  };
  assert.deepEqual(dailyConfig({ periodicNotes }), {
    format: 'YYYY-MM-DD',
    folder: 'days',
    template: 'T/day.md',
  });
});

test('dailyConfig falls back to core Daily notes when Periodic Notes has daily off', () => {
  const periodicNotes = { daily: { enabled: false, folder: 'ignored' } };
  const coreDailyNotes = { folder: 'journal', format: 'DD-MM-YYYY' };
  assert.deepEqual(dailyConfig({ periodicNotes, coreDailyNotes }), {
    format: 'DD-MM-YYYY',
    folder: 'journal',
    template: '',
  });
  assert.equal(dailyConfig({ periodicNotes }), null);
  assert.equal(dailyConfig({}), null);
});

test('notePath joins folder and formatted date', () => {
  const date = fakeMoment('2026-10-15T00:00:00Z');
  assert.equal(
    notePath({ folder: 'calendar/daily', format: 'YYYY-MM-DD' }, date),
    'calendar/daily/2026-10-15.md',
  );
  assert.equal(notePath({ folder: '', format: 'YYYY/MM/DD' }, date), '2026/10/15.md');
});

test('dateOfNote reads the date from a daily note path', () => {
  const config = { folder: 'calendar/daily', format: 'YYYY-MM-DD' };
  assert.equal(
    dateOfNote(config, 'calendar/daily/2026-10-15.md', parse).format('YYYY-MM-DD'),
    '2026-10-15',
  );
  assert.equal(dateOfNote(config, 'calendar/daily/notes.md', parse), null);
  assert.equal(dateOfNote(config, 'elsewhere/2026-10-15.md', parse), null);
  assert.equal(dateOfNote(config, 'calendar/daily/2026-10-15.csv', parse), null);
  assert.equal(
    dateOfNote({ folder: '', format: 'YYYY-MM-DD' }, '2026-10-15.md', parse).format('YYYY-MM-DD'),
    '2026-10-15',
  );
});

test('fillTemplate fills the same placeholders as Periodic Notes', () => {
  const date = fakeMoment('2026-10-15T00:00:00Z');
  const now = fakeMoment('2026-10-15T08:30:00Z');
  const text = [
    '# {{date:YYYY-MM-DD}}',
    '{{title}} at {{time}}',
    '![[plan#{{date:YYYY-MM-DD}}]]',
    '{{yesterday}} / {{tomorrow}} / {{date+1d:MM-DD}}',
    '<% tp.date.now() %>',
  ].join('\n');
  assert.equal(
    fillTemplate(text, { format: 'YYYY-MM-DD', date, now }),
    [
      '# 2026-10-15',
      '2026-10-15 at 08:30',
      '![[plan#2026-10-15]]',
      '2026-10-14 / 2026-10-16 / 10-16',
      '<% tp.date.now() %>',
    ].join('\n'),
  );
});

test('withLogBlock adds a cal-track block at the end, once', () => {
  const note = withLogBlock('# 2026-10-15\n\n## Today\n- [ ] Calorie track\n\n');
  assert.equal(note, '# 2026-10-15\n\n## Today\n- [ ] Calorie track\n\n```cal-track\n```\n');
  assert.ok(hasLogBlock(note));
  assert.equal(withLogBlock(''), '```cal-track\n```\n');
  assert.ok(!hasLogBlock('Some text mentioning cal-track'));
  assert.ok(hasLogBlock('~~~\n````cal-track\ndate: 2026-10-15\n````'));
});
