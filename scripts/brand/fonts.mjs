// Font locations for the brand generators. Both fonts are SIL OFL 1.1; neither is committed.
// Space Grotesk 700 comes from @fontsource/space-grotesk (npm install in this folder).
// JetBrains Mono Bold must be the full TTF (the fontsource subsets lack → and ✓): see README.md.
const here = new URL('.', import.meta.url).pathname;
export const DISPLAY = here + 'node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff';
export const MONO = here + 'fonts/JetBrainsMono-Bold.ttf';
