# Real frames of an animated SVG in headless Chrome. Usage: verify-frames.py /abs/x.svg /tmp/prefix 0.5,3,8 dark|light WIDTH HEIGHT
import asyncio, os, sys
from playwright.async_api import async_playwright
svg, out, times, scheme, w, h = sys.argv[1], sys.argv[2], [float(t) for t in sys.argv[3].split(',')], sys.argv[4], int(sys.argv[5]), int(sys.argv[6])
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=os.environ.get('CHROME') or None)  # CHROME=/path/to/chrome to use a local one
        pg = await b.new_page(viewport={'width': w, 'height': h}, color_scheme=scheme)
        bg = '#0d1117' if scheme == 'dark' else '#ffffff'
        open('/tmp/_v.html', 'w').write(f'<body style="margin:0;background:{bg}"><img src="file://{svg}" width="{w}"></body>')
        await pg.goto('file:///tmp/_v.html'); last = 0
        for t in times:
            await pg.wait_for_timeout(int((t - last) * 1000)); last = t
            await pg.screenshot(path=f'{out}-{scheme}-{t}.png', clip={'x': 0, 'y': 0, 'width': w, 'height': h})
        await b.close()
asyncio.run(main())
