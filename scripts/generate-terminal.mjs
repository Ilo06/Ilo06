#!/usr/bin/env node
/**
 * generate-terminal.mjs
 *
 * Draws the "About" section as an animated terminal window (typing effect),
 * in a light and a dark variant, as self-contained SVGs for the README:
 *
 *   assets/terminal.svg
 *   assets/terminal-dark.svg
 *
 * Pure CSS animation (works inside <img>/<picture> on GitHub, no JS).
 * No dependencies. Requires Node 18+.
 *
 * Usage:   node scripts/generate-terminal.mjs
 * To change the text, edit the SCRIPT array below and run it again.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * Content. `cmd` = typed slowly after a prompt, `out` = printed fast,
 * `blank` = empty row, `prompt` = final idle prompt with blinking cursor.
 * In `out`, a leading "→" is drawn in the accent colour.
 * ------------------------------------------------------------------ */

const USER = 'ilo';
const HOST = 'hei';

const SCRIPT = [
  { t: 'cmd', text: 'cat about.txt' },
  { t: 'out', text: 'I write software, break things, fix them, and occasionally wonder' },
  { t: 'out', text: 'why I decided to use that framework in the first place.' },
  { t: 'blank' },
  { t: 'out', text: 'Currently studying Computer Science at HEI in Madagascar.' },
  { t: 'blank' },
  { t: 'cmd', text: 'cat interests.txt' },
  { t: 'out', text: 'Interested in:', accent: true },
  { t: 'out', text: '→ Backend architecture & APIs development' },
  { t: 'out', text: '→ Geospatial & WebGL experiments' },
  { t: 'out', text: '→ Linux' },
  { t: 'out', text: '→ Game development' },
  { t: 'prompt' },
];

/* ------------------------------------------------------------------ *
 * Geometry & timing
 * ------------------------------------------------------------------ */

const WIDTH = 776; // same grid as the contribution graph / stats
const FONT_SIZE = 14;
const CHAR_W = 8.4; // forced with textLength so every system font lines up
const ROW_H = 22;
const TITLE_H = 36;
const PAD_X = 22;
const PAD_TOP = 18;
const PAD_BOTTOM = 16;
const RADIUS = 10;

const CMD_MS = 75; // per typed character (commands)
const OUT_MS = 22; // per printed character (output)
const START_DELAY = 700; // idle prompt before the first command
const AFTER_CMD = 450; // pause after Enter
const BETWEEN_OUT = 90; // pause between output lines
const BETWEEN_BLOCKS = 700; // pause before the next command
const HOLD = 6500; // finished screen stays visible
const FADE = 900; // fade out before looping

const FONT =
  'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono","DejaVu Sans Mono",monospace';

const THEMES = {
  light: {
    bg: '#f6f8fa', border: '#d0d7de', title: '#57606a', strong: '#1f2328',
    user: '#1a7f37', path: '#0969da', accent: '#0969da', arrow: '#1a7f37', cursor: '#1f2328',
  },
  dark: {
    bg: '#161b22', border: '#30363d', title: '#8b949e', strong: '#e6edf3',
    user: '#3fb950', path: '#58a6ff', accent: '#58a6ff', arrow: '#3fb950', cursor: '#e6edf3',
  },
};

const PROMPT = `${USER}@${HOST}:~$ `;
const PROMPT_W = PROMPT.length * CHAR_W;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ------------------------------------------------------------------ *
 * Layout + timeline (theme independent)
 * ------------------------------------------------------------------ */

function plan() {
  const bodyTop = TITLE_H + PAD_TOP;
  const rows = [];
  let t = START_DELAY;
  let prev = null;

  SCRIPT.forEach((line, i) => {
    const row = { ...line, i, top: bodyTop + i * ROW_H };
    const x0 = PAD_X + (line.t === 'cmd' || line.t === 'prompt' ? PROMPT_W : 0);
    row.x0 = x0;

    if (line.t === 'cmd') {
      if (prev && prev.t === 'out') t += BETWEEN_BLOCKS;
      row.appear = i === 0 ? 0 : t; // prompt visible at this time
      row.start = t;
      row.n = line.text.length;
      row.end = t + row.n * CMD_MS;
      t = row.end + AFTER_CMD;
    } else if (line.t === 'out') {
      row.start = t;
      row.n = line.text.length;
      row.end = t + row.n * OUT_MS;
      t = row.end + BETWEEN_OUT;
    } else if (line.t === 'prompt') {
      t += BETWEEN_BLOCKS - BETWEEN_OUT;
      row.appear = t;
      row.start = row.end = t;
      row.n = 0;
    }
    if (line.t !== 'blank') prev = row;
    rows.push(row);
  });

  const typedEnd = t;
  const total = typedEnd + HOLD + FADE;
  const height = bodyTop + SCRIPT.length * ROW_H + PAD_BOTTOM;
  return { rows, total, typedEnd, height, bodyTop };
}

/* ------------------------------------------------------------------ *
 * SVG
 * ------------------------------------------------------------------ */

function buildSvg(theme) {
  const c = THEMES[theme];
  const { rows, total, height } = plan();
  const T = total;
  const pct = (ms) => r3(Math.min(100, Math.max(0, (ms / T) * 100)));
  const dur = r2(T / 1000);
  const fadeStart = T - FADE;
  const EPS = 0.01;

  const keyframes = [];
  const rules = [];

  /* body fade-out (visual reset of the loop) */
  keyframes.push(
    `@keyframes bd{0%,${pct(fadeStart)}%{opacity:1}${pct(T - FADE * 0.1)}%,100%{opacity:0}}`
  );

  /* cover rects: reveal text left -> right in `n` discrete steps */
  const covers = [];
  const promptsMarkup = [];
  const textMarkup = [];

  for (const row of rows) {
    if (row.t === 'blank') continue;

    const y = r2(row.top);
    const baseline = r2(row.top + ROW_H * 0.7);

    if (row.t === 'cmd' || row.t === 'prompt') {
      promptsMarkup.push(
        `<text class="tx pr p${row.i}" x="${PAD_X}" y="${baseline}" textLength="${r2(PROMPT_W)}" lengthAdjust="spacing">` +
          `<tspan class="us">${USER}@${HOST}</tspan><tspan class="st">:</tspan>` +
          `<tspan class="pa">~</tspan><tspan class="st">$\u00a0</tspan></text>`
      );
      if (row.appear > 0) {
        keyframes.push(
          `@keyframes p${row.i}{0%,${pct(row.appear - 1)}%{opacity:0}${pct(row.appear)}%,${pct(T - FADE * 0.1)}%{opacity:1}100%{opacity:0}}`
        );
        rules.push(`.p${row.i}{animation:p${row.i} ${dur}s infinite both}`);
      }
    }

    if (row.n > 0) {
      const w = r2(row.n * CHAR_W);
      const isOut = row.t === 'out';
      let inner = esc(row.text);
      if (isOut && row.text.startsWith('→')) {
        inner = `<tspan class="ar">→</tspan>${esc(row.text.slice(1))}`;
      }
      const cls = `tx${row.accent ? ' ac' : ''}${row.t === 'cmd' ? ' cm' : ''}`;
      textMarkup.push(
        `<text class="${cls}" x="${r2(row.x0)}" y="${baseline}" textLength="${w}" lengthAdjust="spacing" xml:space="preserve">${inner}</text>`
      );

      covers.push(`<rect class="cv v${row.i}" x="${r2(row.x0)}" y="${y}" width="${w}" height="${ROW_H}"/>`);
      keyframes.push(
        `@keyframes v${row.i}{` +
          `0%,${pct(row.start)}%{transform:translateX(0);animation-timing-function:steps(${row.n},end)}` +
          `${pct(row.end)}%,${pct(T - FADE * 0.35)}%{transform:translateX(${w}px)}` +
          `100%{transform:translateX(0)}}`
      );
      rules.push(`.v${row.i}{animation:v${row.i} ${dur}s infinite both}`);
    }
  }

  /* cursor: follows the typing, jumps between rows, blinks */
  const cursorRows = rows.filter((r) => r.t === 'cmd' || r.t === 'out' || r.t === 'prompt');
  const pos = (x, top) => `translate(${r2(x)}px,${r2(top + 3)}px)`;
  const kf = [];
  const first = cursorRows[0];
  kf.push(`0%{transform:${pos(first.x0, first.top)}}`);
  let prevEnd = null;
  cursorRows.forEach((r) => {
    if (r.t === 'prompt') {
      if (prevEnd) kf.push(`${pct(r.start - EPS * T / 100)}%{transform:${prevEnd}}`);
      const p = pos(r.x0, r.top);
      kf.push(`${pct(r.start)}%,${pct(T - FADE * 0.35)}%{transform:${p}}`);
      prevEnd = p;
      return;
    }
    const a = pos(r.x0, r.top);
    const b = pos(r.x0 + r.n * CHAR_W, r.top);
    if (prevEnd) kf.push(`${pct(r.start - 1)}%{transform:${prevEnd}}`);
    kf.push(`${pct(r.start)}%{transform:${a};animation-timing-function:steps(${r.n},end)}`);
    kf.push(`${pct(r.end)}%{transform:${b}}`);
    prevEnd = b;
  });
  kf.push(`100%{transform:${pos(first.x0, first.top)}}`);
  keyframes.push(`@keyframes cur{${kf.join('')}}`);

  const last = cursorRows.at(-1);
  const finalPos = pos(last.x0, last.top);

  const css =
    `.tx{font-family:${FONT};font-size:${FONT_SIZE}px;fill:${c.strong};white-space:pre}` +
    `.tt{font-family:${FONT};font-size:12px;fill:${c.title}}` +
    `.us{fill:${c.user};font-weight:600}.pa{fill:${c.path};font-weight:600}.st{fill:${c.strong}}` +
    `.ac{fill:${c.accent};font-weight:600}.ar{fill:${c.arrow}}.cm{font-weight:600}` +
    `.cv{fill:${c.bg}}` +
    `.bd{animation:bd ${dur}s infinite both}` +
    `.cg{animation:cur ${dur}s infinite both}` +
    `.cb{fill:${c.cursor};animation:blink 1.05s steps(1,end) infinite}` +
    `@keyframes blink{0%,55%{opacity:.85}56%,100%{opacity:0}}` +
    rules.join('') +
    keyframes.join('') +
    // Reduced motion: show the finished terminal, only the cursor keeps blinking.
    `@media (prefers-reduced-motion:reduce){` +
    `.cv{display:none}.bd,.pr{animation:none!important;opacity:1!important}` +
    `.cg{animation:none!important;transform:${finalPos}}}`;

  /* window chrome */
  const dots = [
    ['#ff5f56', 20],
    ['#ffbd2e', 40],
    ['#27c93f', 60],
  ]
    .map(([fill, cx]) => `<circle cx="${cx}" cy="${TITLE_H / 2}" r="5.5" fill="${fill}"/>`)
    .join('');

  const title = `${USER}@${HOST}: ~`;
  const desc = SCRIPT.filter((l) => l.t === 'out')
    .map((l) => l.text)
    .join(' ');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" ` +
    `viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="ttl dsc" preserveAspectRatio="xMidYMid meet">` +
    `<title id="ttl">About Ilo</title><desc id="dsc">${esc(desc)}</desc>` +
    `<style>${css}</style>` +
    `<defs><clipPath id="win"><rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${r2(height - 1)}" rx="${RADIUS}"/></clipPath></defs>` +
    `<g clip-path="url(#win)">` +
    `<rect width="${WIDTH}" height="${height}" fill="${c.bg}"/>` +
    `<rect width="${WIDTH}" height="${TITLE_H}" fill="${c.bg}"/>` +
    `<line x1="0" y1="${TITLE_H}" x2="${WIDTH}" y2="${TITLE_H}" stroke="${c.border}"/>` +
    dots +
    `<text class="tt" x="${WIDTH / 2}" y="${TITLE_H / 2 + 4}" text-anchor="middle">${esc(title)}</text>` +
    `<g class="bd">${promptsMarkup.join('')}${textMarkup.join('')}${covers.join('')}` +
    `<g class="cg"><rect class="cb" width="${r2(CHAR_W - 0.6)}" height="${FONT_SIZE + 2}" rx="1"/></g></g>` +
    `</g>` +
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${r2(height - 1)}" rx="${RADIUS}" fill="none" stroke="${c.border}"/>` +
    `</svg>`
  );
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const dir = path.resolve(process.cwd(), process.env.OUTPUT_DIR || 'assets');
  await mkdir(dir, { recursive: true });
  const files = [];
  for (const [theme, suffix] of [['light', ''], ['dark', '-dark']]) {
    const file = path.join(dir, `terminal${suffix}.svg`);
    await writeFile(file, buildSvg(theme), 'utf8');
    files.push(path.relative(process.cwd(), file));
  }
  const { total } = plan();
  console.log(`Wrote ${files.join(' and ')} — loop ${(total / 1000).toFixed(1)}s.`);
}

main().catch((err) => {
  console.error(`generate-terminal: ${err.message}`);
  process.exit(1);
});
