// Panter hero: aurora (ambient), mascot with a pulsing connector (rhythm), title/tagline as paths,
// an underline that draws once (entrance). Dark and light in one file; honours prefers-reduced-motion.
// Usage: node gen-hero.mjs <mascot.svg> <out.svg> <lang:en|es>
import fs from 'node:fs';
import { DISPLAY, MONO } from './fonts.mjs';
import { loadFont, textToPath, textWidth } from './textpath.mjs';

const [, , mascotFile, out, lang = 'en'] = process.argv;
const display = loadFont(DISPLAY);
const mono = loadFont(MONO);
const T = {
  en: { kicker: 'OPEN SOURCE · MCP CONTROL PLANE · NO MODEL APIS', tagline: 'One leader. Every model. Every MCP.',
        sub: 'AI apps that work as one engineering team, with evidence on every step.',
        title: 'Panter-ai: one leader, every model, every MCP',
        desc: 'Animated banner. Panter, a black panther with a mouse face whose tail ends in a glowing connector, beside the Panter-ai name and the tagline "One leader. Every model. Every MCP." Soft amber and teal light drifts in the background.' },
  es: { kicker: 'CÓDIGO ABIERTO · CONTROL PLANE MCP · SIN APIS DE MODELOS', tagline: 'Un líder. Todos los modelos. Todos los MCP.',
        sub: 'Apps de IA que trabajan como un equipo, con evidencia en cada paso.',
        title: 'Panter-ai: un líder, todos los modelos, todos los MCP',
        desc: 'Banner animado. Panter, una pantera negra con cara de ratón cuya cola termina en un conector que brilla, junto al nombre Panter-ai y el lema "Un líder. Todos los modelos. Todos los MCP." Una luz suave ámbar y turquesa se mueve al fondo.' },
}[lang];

const W = 1200, H = 380, AMBER = '#f5b301', TEAL = '#2dd4bf', BLUE = '#60a5fa';
// Mascot: reuse the brand drawing, ids renamed, scaled into a 280 px medallion; the connector glow pulses.
let m = fs.readFileSync(mascotFile, 'utf8');
m = m.replace(/^[\s\S]*?<\/desc>/, '').replace(/<\/svg>\s*$/, '').replace(/pm-/g, `ph${lang}-`)
  .replace(/<!--[\s\S]*?-->/g, '');
m = m.replace(/(<circle cx="436" cy="168" r="32" fill="url\(#ph\w+-glow\)")\/>/,
  `$1 class="still"/><circle class="motion" cx="436" cy="168" r="32" fill="url(#ph${lang}-glow)"><animate attributeName="r" values="26;40;26" dur="2.4s" repeatCount="indefinite"/><animate attributeName="opacity" values=".55;1;.55" dur="2.4s" repeatCount="indefinite"/></circle>`);
if (!m.includes('dur="2.4s"')) throw new Error('mascot glow not found');

const X = 400, kick = 15, ts = 104, tg = 30, sb = 17;
const yK = 108, yT = yK + 104, yG = yT + 56, yS = yG + 40;
const titleW = textWidth(display, 'Panter-ai', ts, -1);
const tagW = textWidth(display, T.tagline, tg);
if (X + Math.max(titleW, tagW) > W - 40) throw new Error(`text overflow ${titleW} ${tagW}`);
const P = (F, s, x, y, size, tr = 0) => textToPath(F, s, x, y, size, tr);
const p = `ph${lang}`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="${p}-title ${p}-desc">
  <title id="${p}-title">${T.title}</title>
  <desc id="${p}-desc">${T.desc}</desc>
  <defs>
    <clipPath id="${p}-card"><rect width="${W}" height="${H}" rx="28"/></clipPath>
    <radialGradient id="${p}-b1"><stop offset="0" stop-color="${AMBER}" stop-opacity=".55"/><stop offset="1" stop-color="${AMBER}" stop-opacity="0"/></radialGradient>
    <radialGradient id="${p}-b2"><stop offset="0" stop-color="${TEAL}" stop-opacity=".5"/><stop offset="1" stop-color="${TEAL}" stop-opacity="0"/></radialGradient>
    <radialGradient id="${p}-b3"><stop offset="0" stop-color="${BLUE}" stop-opacity=".35"/><stop offset="1" stop-color="${BLUE}" stop-opacity="0"/></radialGradient>
    <linearGradient id="${p}-ink" x1="0" x2="1">
      <stop offset="0" class="s1" stop-color="${AMBER}"/><stop offset=".55" class="s2" stop-color="#fcd34d"/><stop offset="1" class="s3" stop-color="${TEAL}"/>
      <animateTransform attributeName="gradientTransform" type="translate" values="-0.25 0;0.25 0;-0.25 0" dur="9s" repeatCount="indefinite"/>
    </linearGradient>
    <linearGradient id="${p}-inks" x1="0" x2="1"><stop offset="0" class="s1" stop-color="${AMBER}"/><stop offset=".55" class="s2" stop-color="#fcd34d"/><stop offset="1" class="s3" stop-color="${TEAL}"/></linearGradient>
    <linearGradient id="${p}-rule" gradientUnits="userSpaceOnUse" x1="${X}" y1="0" x2="${W - 40}" y2="0">
      <stop offset="0" class="s1" stop-color="${AMBER}"/><stop offset="1" class="s3" stop-color="${TEAL}"/>
    </linearGradient>
    <pattern id="${p}-grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" class="gl" stroke-width="1"/></pattern>
    <filter id="${p}-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="46"/></filter>
    <style>
      .bg{fill:#0d1117}.gl{stroke:#1b2230}.tag{fill:#f5f0e6}.sub{fill:#9aa3b5}.kick{fill:${TEAL}}.ring{stroke:#2a3142}
      .draw{stroke-dasharray:${W - X - 40};stroke-dashoffset:${W - X - 40};animation:${p}-draw 1.6s cubic-bezier(.4,0,.2,1) .4s forwards}
      .fade{opacity:0;animation:${p}-fade 1s ease 1.1s forwards}
      @keyframes ${p}-draw{to{stroke-dashoffset:0}}
      @keyframes ${p}-fade{to{opacity:1}}
      @media (prefers-color-scheme: light){.bg{fill:#ffffff}.gl{stroke:#eef0f3}.tag{fill:#0d1117}.sub{fill:#57606a}.kick{fill:#0f766e}.ring{stroke:#d0d7de}.s1{stop-color:#b45309}.s2{stop-color:#ca8a04}.s3{stop-color:#0f766e}}
      .still{display:none}
      @media (prefers-reduced-motion: reduce){.motion{display:none}.still{display:inline}.title{fill:url(#${p}-inks)}.draw{animation:none;stroke-dashoffset:0}.fade{animation:none;opacity:1}}
    </style>
  </defs>
  <g clip-path="url(#${p}-card)">
    <rect class="bg" width="${W}" height="${H}"/>
    <g filter="url(#${p}-blur)">
      <g class="motion">
      <circle r="250" cx="190" cy="120" fill="url(#${p}-b1)"><animateTransform attributeName="transform" type="translate" values="0 0;150 70;0 0" dur="11s" repeatCount="indefinite"/></circle>
      <circle r="280" cx="980" cy="330" fill="url(#${p}-b2)"><animateTransform attributeName="transform" type="translate" values="0 0;-180 -90;0 0" dur="13s" repeatCount="indefinite"/></circle>
      <circle r="220" cx="640" cy="20" fill="url(#${p}-b3)"><animateTransform attributeName="transform" type="translate" values="0 0;90 150;0 0" dur="17s" repeatCount="indefinite"/></circle>
      </g>
      <g class="still">
      <circle r="250" cx="190" cy="120" fill="url(#${p}-b1)"/>
      <circle r="280" cx="980" cy="330" fill="url(#${p}-b2)"/>
      <circle r="220" cx="640" cy="20" fill="url(#${p}-b3)"/>
      </g>
    </g>
    <rect width="${W}" height="${H}" fill="url(#${p}-grid)" opacity=".55"/>
    <rect class="ring" x="1" y="1" width="${W - 2}" height="${H - 2}" rx="27" fill="none" stroke-width="2"/>
    <g transform="translate(56 50) scale(0.547)">${m}</g>
    <path class="kick" d="${P(mono, T.kicker, X, yK, kick, 1.5)}"/>
    <path class="title" fill="url(#${p}-ink)" d="${P(display, 'Panter-ai', X, yT, ts, -1)}"/>
    <path class="tag" d="${P(display, T.tagline, X, yG, tg)}"/>
    <path class="sub fade" d="${P(mono, T.sub, X, yS, sb)}"/>
    <line class="draw" x1="${X}" y1="${yS + 34}" x2="${W - 40}" y2="${yS + 34}" stroke="url(#${p}-rule)" stroke-width="3" stroke-linecap="round"/>
  </g>
</svg>
`;
if (/NaN/.test(svg)) throw new Error('NaN in output');
fs.writeFileSync(out, svg);
console.log('ok', out, (svg.length / 1024).toFixed(1) + ' KB', 'title', titleW.toFixed(0), 'tag', tagW.toFixed(0), 'sub', textWidth(mono, T.sub, sb).toFixed(0));
