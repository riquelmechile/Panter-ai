// Terminal that types, holds and erases each line with exact glyph widths (font as paths, no JS, no server).
// Each line is "actor → event": the actor is teal, the event uses the brand gradient.
// Usage: node gen-typing.mjs <out.svg> <lang:en|es>
import fs from 'node:fs';
import { DISPLAY, MONO } from './fonts.mjs';
import { loadFont, textToPath, layout } from './textpath.mjs';

const [, , out, lang = 'en'] = process.argv;
const F = loadFont(MONO);
const T = {
  en: { label: '~/panter-ai · workforce log', title: 'A task moving through Panter-ai',
        lines: ['claude → delegate: implement the fix', 'panter → wake grok · webhook 200', 'grok → claim · branch panter/grok-0877',
                'grok → open PR #7 · evidence attached', 'reviewer → approve the exact SHA 3087289', 'claude → merge --match-head-commit ✓'] },
  es: { label: '~/panter-ai · bitácora del workforce', title: 'Una tarea recorriendo Panter-ai',
        lines: ['claude → delega: implementa el arreglo', 'panter → despierta a grok · webhook 200', 'grok → toma el trabajo · rama panter/grok-0877',
                'grok → abre el PR #7 · con evidencia', 'revisor → aprueba el SHA exacto 3087289', 'claude → merge --match-head-commit ✓'] },
}[lang];

const W = 1200, H = 136, size = 30, X0 = 48, Y = 104, p = `pt${lang}`;
const typeT = 0.055, delT = 0.022, hold = 1.7, gap = 0.35;
// Timeline of revealed width (key points) shared by the clip and the cursor.
let t = 0; const kTimes = [], kW = []; const push = (time, w) => { kTimes.push(time); kW.push(w); };
push(0, 0); t += 0.4; push(t, 0); // initial delay: duplicate keyTimes would invalidate the animation
const windows = [];
for (const line of T.lines) {
  const L = layout(F, line, 0, 0, size); const widths = [0]; let acc = 0;
  for (const it of L.items) { acc += it.adv; widths.push(acc); }
  if (X0 + acc > W - 48) throw new Error(`line too wide: ${line} ${acc}`);
  const start = t;
  for (let i = 1; i < widths.length; i++) { t += typeT; push(t, widths[i]); }
  t += hold; push(t, acc);
  for (let i = widths.length - 2; i >= 0; i--) { t += delT; push(t, widths[i]); }
  t += gap; push(t, 0);
  windows.push([start, t]);
}
const total = t, dur = `${total.toFixed(2)}s`;
const kt = kTimes.map(x => (x / total).toFixed(4)).join(';');
let lines = '';
T.lines.forEach((line, i) => {
  const [a, b] = windows[i];
  const anim = `<animate attributeName="opacity" values="0;1;0;0" keyTimes="0;${(a / total).toFixed(4)};${(b / total).toFixed(4)};1" calcMode="discrete" dur="${dur}" repeatCount="indefinite"/>`;
  const cut = line.indexOf('→') + 1;
  const actor = line.slice(0, cut), rest = line.slice(cut);
  const aw = layout(F, actor, 0, 0, size).width;
  lines += `    <g class="ln ln${i}" clip-path="url(#${p}-reveal)" opacity="0">${anim}<path class="actor" d="${textToPath(F, actor, X0, Y, size)}"/><path fill="url(#${p}-ink)" d="${textToPath(F, rest, X0 + aw, Y, size)}"/></g>\n`;
});
// Reduced motion: SMIL outranks CSS in Chrome, so the static frame is a separate group toggled with display.
const still = (() => { const line = T.lines[0], cut = line.indexOf('→') + 1, actor = line.slice(0, cut);
  return `<path class="actor" d="${textToPath(F, actor, X0, Y, size)}"/><path fill="url(#${p}-ink)" d="${textToPath(F, line.slice(cut), X0 + layout(F, actor, 0, 0, size).width, Y, size)}"/>`; })();
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="${p}-title ${p}-desc">
  <title id="${p}-title">${T.title}</title>
  <desc id="${p}-desc">${T.lines.join(' / ')}</desc>
  <defs>
    <linearGradient id="${p}-ink" gradientUnits="userSpaceOnUse" x1="${X0}" y1="0" x2="${W - 48}" y2="0"><stop offset="0" class="i1" stop-color="#f5b301"/><stop offset="1" class="i2" stop-color="#fcd34d"/></linearGradient>
    <clipPath id="${p}-reveal"><rect class="rv" x="${X0 - 2}" y="0" width="0" height="${H}"><animate attributeName="width" values="${kW.map(w => (w + 4).toFixed(1)).join(';')}" keyTimes="${kt}" calcMode="discrete" dur="${dur}" repeatCount="indefinite"/></rect></clipPath>
    <style>
      .frame{fill:#0d1117;stroke:#2a3142}.label{fill:#9aa3b5}.actor{fill:#2dd4bf}.cur{fill:#f5f0e6}
      @media (prefers-color-scheme: light){.frame{fill:#f6f8fa;stroke:#d0d7de}.label{fill:#57606a}.actor{fill:#0f766e}.cur{fill:#0d1117}.i1{stop-color:#b45309}.i2{stop-color:#a16207}}
      .still{display:none}
      @media (prefers-reduced-motion: reduce){.motion{display:none}.still{display:inline}}
    </style>
  </defs>
  <rect class="frame" x="1" y="1" width="${W - 2}" height="${H - 2}" rx="20" stroke-width="2"/>
  <circle cx="30" cy="30" r="6" fill="#f87171"/><circle cx="50" cy="30" r="6" fill="#f5b301"/><circle cx="70" cy="30" r="6" fill="#2dd4bf"/>
  <path class="label" d="${textToPath(F, T.label.toUpperCase(), 92, 35, 12, 1.4)}"/>
  <g class="still">${still}</g>
  <g class="motion">
${lines}  <rect class="cur" x="${X0}" y="${Y - size + 2}" width="3" height="${size + 6}" rx="1.5">
    <animate attributeName="x" values="${kW.map(w => (X0 + w + 3).toFixed(1)).join(';')}" keyTimes="${kt}" calcMode="discrete" dur="${dur}" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="1;1;0;0;1" dur="1s" calcMode="discrete" repeatCount="indefinite"/>
  </rect>
  </g>
</svg>
`;
if (/NaN/.test(svg)) throw new Error('NaN');
fs.writeFileSync(out, svg);
console.log('ok', out, (svg.length / 1024).toFixed(1) + ' KB', 'cycle', total.toFixed(1) + 's');
