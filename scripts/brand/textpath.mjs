// Text → SVG path data without GSUB (works with modern variable fonts). Never uses toPathData().
import opentype from 'opentype.js';
import fs from 'node:fs';
export const loadFont = f => { const b = fs.readFileSync(f); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const r = v => (Math.round(v * 100) / 100).toString();
export const cmdsToD = cmds => cmds.map(c => c.type === 'M' || c.type === 'L' ? `${c.type}${r(c.x)} ${r(c.y)}`
  : c.type === 'C' ? `C${r(c.x1)} ${r(c.y1)} ${r(c.x2)} ${r(c.y2)} ${r(c.x)} ${r(c.y)}`
  : c.type === 'Q' ? `Q${r(c.x1)} ${r(c.y1)} ${r(c.x)} ${r(c.y)}` : 'Z').join('');
export function layout(F, text, x, y, size, tracking = 0) {
  const out = []; const chars = [...text]; let cx = x;
  for (let i = 0; i < chars.length; i++) {
    const g = F.charToGlyph(chars[i]); const d = cmdsToD(g.getPath(cx, y, size).commands);
    const adv = (g.advanceWidth / F.unitsPerEm) * size; out.push({ ch: chars[i], x: cx, d, adv }); cx += adv + tracking;
    if (i < chars.length - 1) cx += ((F.getKerningValue(g, F.charToGlyph(chars[i + 1])) || 0) / F.unitsPerEm) * size;
  }
  return { items: out, width: cx - x };
}
export const textToPath = (F, text, x, y, size, tracking = 0) => layout(F, text, x, y, size, tracking).items.map(i => i.d).join('');
export const textWidth = (F, text, size, tracking = 0) => layout(F, text, 0, 0, size, tracking).width;
