import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const assets = join(root, 'docs', 'assets');
const svgs = readdirSync(assets).filter(f => f.endsWith('.svg'));

test('brand SVGs are accessible, pure vector and self-contained', () => {
  assert.ok(svgs.length >= 3);
  for (const file of svgs) {
    const svg = readFileSync(join(assets, file), 'utf8');
    const open = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
    assert.match(open, /\sviewBox="0 0 \d+ \d+"/, `${file}: viewBox`);
    assert.match(open, /\srole="img"/, `${file}: role="img"`);
    const labelled = /\saria-labelledby="([^"]+)"/.exec(open)?.[1]?.split(/\s+/) ?? [];
    assert.equal(labelled.length, 2, `${file}: aria-labelledby names a title and a desc`);
    const [titleId, descId] = labelled;
    assert.match(svg, new RegExp(`<title id="${titleId}">[^<]{3,}</title>`), `${file}: non-empty <title>`);
    assert.match(svg, new RegExp(`<desc id="${descId}">[^<]{20,}</desc>`), `${file}: non-empty <desc>`);
    for (const banned of [/<script/i, /<image/i, /<foreignObject/i, /\son[a-z]+=/i, /javascript:/i, /data:/i, /href="https?:/i, /url\(\s*['"]?https?:/i])
      assert.doesNotMatch(svg, banned, `${file}: ${banned}`);
    const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${file}: unique ids`);
    for (const ref of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(ref[1]!), `${file}: url(#${ref[1]}) is defined`);
  }
});

test('every image the README embeds is a file in this repository', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const urls = [...readme.matchAll(/<img\s[^>]*src="([^"]+)"/g)].map(m => m[1]!);
  assert.ok(urls.length >= 3);
  for (const url of urls) {
    const m = /^https:\/\/raw\.githubusercontent\.com\/riquelmechile\/Panter-ai\/main\/(.+\.svg)$/.exec(url);
    assert.ok(m, `canonical raw URL: ${url}`);
    assert.ok(existsSync(join(root, m[1]!)), `maps to a real file: ${m[1]}`);
  }
  for (const link of readme.matchAll(/\]\(((?:docs\/|deploy\/|src\/)?[A-Za-z0-9_./-]+\.(?:md|ts|example))\)/g))
    assert.ok(existsSync(join(root, link[1]!)), `README link resolves: ${link[1]}`);
});
