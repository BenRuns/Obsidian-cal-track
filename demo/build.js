'use strict';

// Builds demo/dist/cal-track-demo.html: a single self-contained page that runs
// the plugin's units / food / table modules and Table Calc's engine in a
// browser, with sample foods instead of live database lookups.

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const out = esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'demo.js')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
});
const shell = fs.readFileSync(path.join(__dirname, 'shell.html'), 'utf8');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const file = path.join(__dirname, 'dist', 'cal-track-demo.html');
fs.writeFileSync(file, `${shell}\n<script>\n${out.outputFiles[0].text}\n</script>\n`);
console.log(`Wrote ${path.relative(process.cwd(), file)}`);
