/**
 * Cheap structural check: every DOM id looked up in assets/app.js must exist in
 * index.html, and every element id in index.html must be wired or documented.
 *
 * Run with:  node tests/dom-ids.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const html = readFileSync(join(root, 'index.html'), 'utf8');
const appJs = readFileSync(join(root, 'assets', 'app.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const usedIds = new Set([...appJs.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]));

const missing = [...usedIds].filter((id) => !htmlIds.has(id));
assert.deepEqual(
    missing,
    [],
    `app.js references ids that index.html does not define: ${missing.join(', ')}`
);

assert.ok(usedIds.size > 10, 'expected the UI wiring to touch a reasonable number of elements');
assert.ok(
    html.includes('type="module"') && html.includes('assets/app.js'),
    'index.html must load assets/app.js as a module'
);
assert.ok(html.includes('assets/styles.css'), 'index.html must load the stylesheet');

const scriptAssets = [...html.matchAll(/(?:src|href)="(assets\/[^"]+)"/g)].map((match) => match[1]);
for (const asset of scriptAssets) {
    readFileSync(join(root, asset), 'utf8'); // throws if the file is missing
}

for (const id of htmlIds) {
    assert.ok(!/^\s*$/.test(id), 'no empty ids');
}

console.log(`  ok   ${usedIds.size} wired ids all exist in index.html`);
console.log(`  ok   ${scriptAssets.length} referenced assets exist`);
console.log(`\n1/1 tests passed`);
