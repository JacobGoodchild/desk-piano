import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// sw.js saves the app's own files at install (offline after one visit): every page and source file
// must be in its list, and in the Pages deploy copy list.
test('every source file and page is saved for offline use and deployed', () => {
  const sw = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
  const wf = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const src = readdirSync(new URL('../../src/', import.meta.url)).filter((f) => /\.(js|css)$/.test(f)).map((f) => `src/${f}`);
  for (const f of [...src, 'index.html', 'print.html', 'help.html']) assert.ok(sw.includes(`'${f}'`), `${f} missing from sw.js APP list`);
  const copy = wf.split('\n').find((l) => l.includes('cp -r')) || '';
  for (const f of ['index.html', 'print.html', 'help.html', 'sw.js', 'src', 'vendor', 'samples']) assert.ok(copy.split(/\s+/).includes(f), `${f} missing from the Pages copy step`);
});
