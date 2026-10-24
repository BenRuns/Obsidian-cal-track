// Builds demo/dist/cal-track-demo.html: a single self-contained page that runs
// the plugin's units / food / CSV log modules in a
// browser, with sample foods instead of live database lookups.

import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';

const out = esbuild.buildSync({
  entryPoints: [path.join(import.meta.dirname, 'demo.js')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
});
const shell = fs.readFileSync(path.join(import.meta.dirname, 'shell.html'), 'utf8');
fs.mkdirSync(path.join(import.meta.dirname, 'dist'), { recursive: true });
const file = path.join(import.meta.dirname, 'dist', 'cal-track-demo.html');
fs.writeFileSync(file, `${shell}\n<script>\n${out.outputFiles[0].text}\n</script>\n`);
console.log(`Wrote ${path.relative(process.cwd(), file)}`);
