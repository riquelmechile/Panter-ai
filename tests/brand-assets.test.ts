import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const assets = join(root, 'docs', 'assets');
const svgs = readdirSync(assets).filter(f => f.endsWith('.svg'));

/** Null when every tag is closed in order (enough for hand-written SVG: no DTD, CDATA or processing instructions). */
function wellFormed(xml: string): string | null {
  const stack: string[] = [];
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (!/^\s*<svg\b/.test(body)) return 'does not start with <svg>';
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (!close) { stack.push(name!); continue; }
    if (stack.pop() !== name) return `unexpected </${name}>`;
  }
  if (stack.length) return `unclosed <${stack.at(-1)}>`;
  if (body.replace(/<[^>]*>/g, '').includes('<')) return 'stray <';
  return null;
}

test('the well-formedness check catches what a browser would refuse', () => {
  assert.equal(wellFormed('<svg><g><circle r="1"/></g></svg>'), null);
  assert.match(wellFormed('<svg><g><circle r="1"></g></svg>')!, /unexpected/);
  assert.match(wellFormed('<svg><g></g>')!, /unclosed/);
});

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
    assert.equal(wellFormed(svg), null, `${file}: well-formed XML`);
    for (const banned of [/<script/i, /<image/i, /<foreignObject/i, /\son[a-z]+=/i, /javascript:/i, /data:/i, /href="https?:/i, /url\(\s*['"]?https?:/i, /@import/i])
      assert.doesNotMatch(svg, banned, `${file}: ${banned}`);
    const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${file}: unique ids`);
    for (const ref of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(ref[1]!), `${file}: url(#${ref[1]}) is defined`);
  }
});

test('animated SVGs stand still for readers who ask for reduced motion', () => {
  const animated = svgs.filter(f => /<animate|@keyframes/.test(readFileSync(join(assets, f), 'utf8')));
  assert.ok(animated.length >= 4);
  for (const file of animated) {
    const svg = readFileSync(join(assets, file), 'utf8');
    // SMIL outranks CSS in Chrome, so a reduced-motion rule must hide the moving parts with display.
    const rule = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([^@]*)\}/.exec(svg)?.[1] ?? '';
    assert.match(rule, /display:\s*none/, `${file}: prefers-reduced-motion hides the animation`);
    const smil = [...svg.matchAll(/<animate(?:Transform|Motion)?\b/g)].length;
    if (smil) assert.ok(/class="(?:motion|pkt)"/.test(svg), `${file}: SMIL lives inside a hideable group`);
  }
});

for (const name of ['README.md', 'README.es.md'])
test(`every image ${name} embeds is a file in this repository`, () => {
  const readme = readFileSync(join(root, name), 'utf8');
  const urls = [...readme.matchAll(/<img\s[^>]*src="([^"]+)"/g)].map(m => m[1]!);
  assert.ok(urls.length >= 3);
  for (const url of urls) {
    // Relative paths: they render on GitHub and in any fork, with no owner baked into the README.
    const m = /^(docs\/assets\/[A-Za-z0-9_.-]+\.svg)$/.exec(url);
    assert.ok(m, `relative asset path: ${url}`);
    assert.ok(existsSync(join(root, m[1]!)), `maps to a real file: ${m[1]}`);
  }
  for (const link of readme.matchAll(/<a\s[^>]*href="([^"#:]+)"/g)) assert.ok(existsSync(join(root, link[1]!)), `README navigation link resolves: ${link[1]}`);
  for (const link of readme.matchAll(/\]\(((?:docs\/|deploy\/|src\/)?[A-Za-z0-9_./-]+\.(?:md|ts|example))\)/g))
    assert.ok(existsSync(join(root, link[1]!)), `README link resolves: ${link[1]}`);
});

test('the English and Spanish READMEs show the same diagrams, each in its own language', () => {
  const imgs = (name: string) => [...readFileSync(join(root, name), 'utf8').matchAll(/<img\s[^>]*src="docs\/assets\/([A-Za-z0-9_.-]+)\.svg"/g)].map(m => m[1]!);
  const en = imgs('README.md'), es = imgs('README.es.md');
  assert.equal(es.length, en.length, 'same number of images');
  en.forEach((file, i) => {
    const spanish = existsSync(join(assets, `${file}.es.svg`)) ? `${file}.es` : file;
    assert.equal(es[i], spanish, `image ${i + 1}: README.es.md shows ${spanish}.svg`);
  });
  assert.match(readFileSync(join(root, 'README.md'), 'utf8'), /href="README\.es\.md"/);
  assert.match(readFileSync(join(root, 'README.es.md'), 'utf8'), /href="README\.md"/);
});
