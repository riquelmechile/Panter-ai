#!/bin/sh
# Regenerates every SVG in docs/assets except the mascot. Run from scripts/brand after README.md setup.
set -eu
A=../../docs/assets
node gen-hero.mjs "$A/panter-mascot.svg" "$A/panter-hero.svg" en
node gen-hero.mjs "$A/panter-mascot.svg" "$A/panter-hero.es.svg" es
node gen-typing.mjs "$A/panter-typing.svg" en
node gen-typing.mjs "$A/panter-typing.es.svg" es
python3 gen-diagrams.py "$A"
