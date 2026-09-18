#!/usr/bin/env node
/**
 * generate-contributions.mjs
 *
 * Fetches REAL GitHub contribution data through the official GitHub GraphQL API
 * (contributionsCollection.contributionCalendar) and renders an animated,
 * self-contained SVG contribution graph for a profile README.
 *
 * No dependencies. Requires Node 18+ (global fetch).
 *
 * Usage:
 *   GITHUB_USERNAME=octocat GH_TOKEN=ghp_xxx node scripts/generate-contributions.mjs
 *   DEMO=1 node scripts/generate-contributions.mjs      # offline render test, synthetic data
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * Configuration (everything is env-driven, nothing hard-coded)
 * ------------------------------------------------------------------ */

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const num = (k, d) => {
  const v = Number.parseFloat(env(k, ''));
  return Number.isFinite(v) ? v : d;
};
const bool = (k, d) => {
  const v = env(k, '').toLowerCase();
  if (!v) return d;
  return !['0', 'false', 'no', 'off'].includes(v);
};

const CFG = {
  username: env('GITHUB_USERNAME'),
  token: env('GH_TOKEN') || env('GITHUB_TOKEN'),
  demo: bool('DEMO', false),

  outDir: env('OUTPUT_DIR', 'output'),
  fileBase: env('OUTPUT_BASENAME', 'contributions'),

  // Date range. YEAR wins over FROM/TO; if none set, trailing 53 weeks.
  year: env('YEAR'),
  from: env('DATE_FROM'),
  to: env('DATE_TO'),

  // Geometry (pixels)
  cell: num('CELL_SIZE', 11),
  spacing: num('CELL_SPACING', 3),
  radius: num('BORDER_RADIUS', 2.5),

  // Levels: number of NON-ZERO intensity levels (GitHub uses 4)
  levels: Math.max(1, Math.round(num('CONTRIBUTION_LEVELS', 4))),

  // Animation timings, milliseconds (all divided by ANIMATION_SPEED)
  revealDuration: num('REVEAL_DURATION', 4000), // left-to-right sweep
  cellFade: num('CELL_FADE_DURATION', 560), // per-cell fade/scale in
  holdDuration: num('HOLD_DURATION', 2500), // full graph stays visible
  outroDuration: num('OUTRO_DURATION', 900), // fade back to empty
  loopGap: num('LOOP_GAP', 500), // empty pause before restart
  speed: Math.max(0.05, num('ANIMATION_SPEED', 1)),
  popScale: num('POP_SCALE', 1.16), // overshoot of the busiest cells

  // Chrome
  showLabels: bool('SHOW_LABELS', true),
  showLegend: bool('SHOW_LEGEND', true),
  showTotal: bool('SHOW_TOTAL', true),

  // Palettes: comma-separated hex, level0 first. Empty = GitHub defaults.
  colorsLight: env('COLORS_LIGHT'),
  colorsDark: env('COLORS_DARK'),
  textLight: env('TEXT_COLOR_LIGHT', '#57606a'),
  textDark: env('TEXT_COLOR_DARK', '#8b949e'),
};

const GITHUB_LIGHT = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];
const GITHUB_DARK = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'];

/* ------------------------------------------------------------------ *
 * Date range helpers
 * ------------------------------------------------------------------ */

function resolveRange() {
  if (CFG.year) {
    const y = Number.parseInt(CFG.year, 10);
    return {
      from: new Date(Date.UTC(y, 0, 1, 0, 0, 0)),
      to: new Date(Date.UTC(y, 11, 31, 23, 59, 59)),
      label: `in ${y}`,
    };
  }
  if (CFG.from) {
    const from = new Date(`${CFG.from}T00:00:00Z`);
    const to = CFG.to ? new Date(`${CFG.to}T23:59:59Z`) : new Date();
    return { from, to, label: `from ${CFG.from} to ${CFG.to || 'today'}` };
  }
  const to = new Date();
  const from = new Date(to.getTime() - 371 * 864e5); // 53 weeks
  return { from, to, label: 'in the last year' };
}

/* ------------------------------------------------------------------ *
 * Data: official GitHub GraphQL API (no HTML scraping)
 * ------------------------------------------------------------------ */

const QUERY = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        totalContributions
        weeks {
          firstDay
          contributionDays { date weekday contributionCount }
        }
      }
    }
  }
}`;

async function fetchCalendar(range) {
  if (!CFG.username) throw new Error('GITHUB_USERNAME is not set.');
  if (!CFG.token) throw new Error('No token found. Set GH_TOKEN (or GITHUB_TOKEN).');

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CFG.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'animated-contribution-graph',
    },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        login: CFG.username,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GitHub API error: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  const user = json.data?.user;
  if (!user) throw new Error(`User "${CFG.username}" not found or not visible to this token.`);

  const cal = user.contributionsCollection.contributionCalendar;
  return {
    total: cal.totalContributions,
    weeks: cal.weeks.map((w) => ({
      firstDay: w.firstDay,
      days: w.contributionDays.map((d) => ({
        date: d.date,
        weekday: d.weekday,
        count: d.contributionCount,
      })),
    })),
  };
}

/** Deterministic synthetic data — ONLY for local rendering tests (DEMO=1). */
function demoCalendar(range) {
  let seed = 20260918;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const start = new Date(range.from);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const weeks = [];
  let total = 0;
  for (let w = 0; w < 53; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(start.getTime() + (w * 7 + d) * 864e5);
      if (day > range.to) break;
      const weekend = d === 0 || d === 6;
      const r = rnd();
      let c = 0;
      if (r > (weekend ? 0.72 : 0.34)) c = Math.ceil(rnd() ** 2.4 * 22);
      total += c;
      days.push({ date: day.toISOString().slice(0, 10), weekday: d, count: c });
    }
    if (days.length) weeks.push({ firstDay: days[0].date, days });
  }
  return { total, weeks, demo: true };
}

/* ------------------------------------------------------------------ *
 * Colors
 * ------------------------------------------------------------------ */

const hex2rgb = (h) => {
  const s = h.replace('#', '');
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => Number.parseInt(f.slice(i, i + 2), 16));
};
const rgb2hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Sample `n` colors along a ramp defined by `stops`. */
function ramp(stops, n) {
  if (n === 1) return [stops[stops.length - 1]];
  const rgbs = stops.map(hex2rgb);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * (rgbs.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(rgbs.length - 1, lo + 1);
    const f = t - lo;
    return rgb2hex(rgbs[lo].map((v, k) => v + (rgbs[hi][k] - v) * f));
  });
}

/** Returns levels+1 colors (index 0 = empty day). */
function palette(custom, defaults) {
  if (custom) {
    const list = custom.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length === CFG.levels + 1) return list;
    if (list.length >= 2) return [list[0], ...ramp(list.slice(1), CFG.levels)];
  }
  return [defaults[0], ...ramp(defaults.slice(1), CFG.levels)];
}

/* ------------------------------------------------------------------ *
 * Level thresholds (quantiles of non-zero days, like GitHub)
 * ------------------------------------------------------------------ */

function levelFn(weeks) {
  const counts = weeks
    .flatMap((w) => w.days.map((d) => d.count))
    .filter((c) => c > 0)
    .sort((a, b) => a - b);
  if (!counts.length) return () => 0;

  const q = (p) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))];
  const cuts = [];
  for (let k = 1; k < CFG.levels; k++) cuts.push(Math.max(cuts.at(-1) ?? 1, q(k / CFG.levels)));

  return (count) => {
    if (count <= 0) return 0;
    let lvl = 1;
    for (let i = 0; i < cuts.length; i++) if (count >= cuts[i]) lvl = i + 2;
    return Math.min(lvl, CFG.levels);
  };
}

/* ------------------------------------------------------------------ *
 * SVG rendering
 * ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
const r2 = (n) => Math.round(n * 100) / 100;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildSvg(cal, range, theme) {
  const step = CFG.cell + CFG.spacing;
  const W = cal.weeks.length;
  const colors = palette(theme === 'dark' ? CFG.colorsDark : CFG.colorsLight,
                         theme === 'dark' ? GITHUB_DARK : GITHUB_LIGHT);
  const text = theme === 'dark' ? CFG.textDark : CFG.textLight;
  const toLevel = levelFn(cal.weeks);

  const PAD = 4;
  const labelW = CFG.showLabels ? Math.round(CFG.cell * 2.6) : 0;
  const monthH = CFG.showLabels ? Math.round(CFG.cell * 1.5) : 0;
  const titleH = CFG.showTotal ? Math.round(CFG.cell * 1.9) : 0;
  const legendH = CFG.showLegend ? Math.round(CFG.cell * 2.0) : 0;

  const gridX = PAD + labelW;
  const gridY = PAD + titleH + monthH;
  const gridW = W * step - CFG.spacing;
  const gridH = 7 * step - CFG.spacing;
  const width = gridX + gridW + PAD;
  const height = gridY + gridH + legendH + PAD;

  /* ---- timeline ------------------------------------------------- */
  const reveal = CFG.revealDuration / CFG.speed;
  const fade = CFG.cellFade / CFG.speed;
  const hold = CFG.holdDuration / CFG.speed;
  const outro = CFG.outroDuration / CFG.speed;
  const gap = CFG.loopGap / CFG.speed;
  const T = reveal + fade + hold + outro + gap;
  const pct = (ms) => r2(Math.min(100, Math.max(0, (ms / T) * 100)));

  const visibleFrom = reveal + fade;
  const fadeOutAt = visibleFrom + hold;
  const emptyAt = fadeOutAt + outro;

  /* ---- per-week keyframes (one animation per column) ------------- */
  const frames = [];
  for (let w = 0; w < W; w++) {
    const start = W > 1 ? (w / (W - 1)) * reveal : 0;
    const p0 = pct(start);
    const p1 = pct(start + fade * 0.62);
    const p2 = pct(start + fade);
    const p3 = pct(fadeOutAt);
    const p4 = pct(emptyAt);
    const head = p0 > 0 ? `0%,${p0}%` : '0%';
    frames.push(
      `@keyframes k${w}{${head}{opacity:0;transform:scale(.5)}` +
        `${p1}%{opacity:1;transform:scale(var(--pop,1))}` +
        `${p2}%,${p3}%{opacity:1;transform:scale(1)}` +
        `${p4}%,100%{opacity:0;transform:scale(.92)}}`
    );
  }

  const popFor = (lvl) =>
    lvl === 0 ? 1 : r2(1 + (CFG.popScale - 1) * (lvl / CFG.levels) ** 1.5);

  const css = [
    `.c{transform-box:fill-box;transform-origin:50% 50%;` +
      `animation-duration:${r2(T / 1000)}s;animation-iteration-count:infinite;` +
      `animation-timing-function:cubic-bezier(.22,.9,.3,1);animation-fill-mode:both}`,
    ...Array.from({ length: W }, (_, w) => `.w${w}{animation-name:k${w}}`),
    ...Array.from({ length: CFG.levels + 1 }, (_, l) => `.l${l}{fill:${colors[l]};--pop:${popFor(l)}}`),
    `.t{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;` +
      `fill:${text};font-size:${r2(CFG.cell * 0.82)}px}`,
    `.t.b{font-size:${r2(CFG.cell * 1.05)}px;font-weight:600}`,
    `.f{opacity:0;animation:fadeui ${r2(T / 1000)}s infinite both;` +
      `animation-timing-function:ease-in-out}`,
    `@keyframes fadeui{0%{opacity:0}${pct(fade)}%,${pct(fadeOutAt)}%{opacity:1}` +
      `${pct(emptyAt)}%,100%{opacity:0}}`,
    ...frames,
    // Respect the reader's motion settings: show the finished graph, no motion.
    `@media (prefers-reduced-motion:reduce){.c,.f{animation:none!important;opacity:1!important;transform:none!important}}`,
  ].join('');

  /* ---- cells ----------------------------------------------------- */
  const cells = [];
  for (let w = 0; w < W; w++) {
    for (const d of cal.weeks[w].days) {
      const x = r2(gridX + w * step);
      const y = r2(gridY + d.weekday * step);
      cells.push(
        `<rect class="c w${w} l${toLevel(d.count)}" x="${x}" y="${y}" ` +
          `width="${CFG.cell}" height="${CFG.cell}" rx="${CFG.radius}"/>`
      );
    }
  }

  /* ---- labels ---------------------------------------------------- */
  const labels = [];
  if (CFG.showLabels) {
    let lastLabel = -3;
    let lastMonth = -1;
    for (let w = 0; w < W; w++) {
      const m = new Date(`${cal.weeks[w].firstDay}T00:00:00Z`).getUTCMonth();
      if (m !== lastMonth && w - lastLabel >= 3 && w <= W - 3) {
        labels.push(
          `<text class="t f" x="${r2(gridX + w * step)}" y="${r2(gridY - CFG.cell * 0.55)}">${MONTHS[m]}</text>`
        );
        lastLabel = w;
      }
      lastMonth = m;
    }
    DOW.forEach((name, i) => {
      if (!name) return;
      labels.push(
        `<text class="t f" x="${r2(gridX - CFG.cell * 0.7)}" y="${r2(gridY + i * step + CFG.cell * 0.82)}" text-anchor="end">${name}</text>`
      );
    });
  }

  if (CFG.showTotal) {
    labels.push(
      `<text class="t b f" x="${PAD}" y="${r2(PAD + CFG.cell * 1.1)}">` +
        `${cal.total.toLocaleString('en-US')} contributions ${esc(range.label)}</text>`
    );
  }

  if (CFG.showLegend) {
    const ly = r2(gridY + gridH + CFG.cell * 0.95);
    const swW = (CFG.levels + 1) * step - CFG.spacing;
    const moreX = width - PAD;
    const swX = moreX - CFG.cell * 2.6 - swW;
    const lessX = swX - CFG.cell * 0.6;
    labels.push(
      `<text class="t f" x="${r2(lessX)}" y="${r2(ly + CFG.cell * 0.8)}" text-anchor="end">Less</text>`
    );
    for (let l = 0; l <= CFG.levels; l++) {
      labels.push(
        `<rect class="f l${l}" x="${r2(swX + l * step)}" y="${ly}" width="${CFG.cell}" height="${CFG.cell}" rx="${CFG.radius}"/>`
      );
    }
    labels.push(
      `<text class="t f" x="${r2(moreX)}" y="${r2(ly + CFG.cell * 0.8)}" text-anchor="end">More</text>`
    );
  }

  const title = `${esc(CFG.username || 'demo')}'s GitHub contributions`;
  const desc =
    `Animated contribution graph: ${cal.total.toLocaleString('en-US')} contributions ` +
    `${range.label}, drawn week by week from left to right.`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="ttl dsc" ` +
    `preserveAspectRatio="xMidYMid meet">` +
    `<title id="ttl">${title}</title><desc id="dsc">${desc}</desc>` +
    `<style>${css}</style>` +
    `<g>${cells.join('')}</g><g>${labels.join('')}</g></svg>`
  );
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const range = resolveRange();
  const cal = CFG.demo ? demoCalendar(range) : await fetchCalendar(range);

  if (!cal.weeks.length) throw new Error('No contribution weeks returned for this range.');

  const dir = path.resolve(process.cwd(), CFG.outDir);
  await mkdir(dir, { recursive: true });

  const light = path.join(dir, `${CFG.fileBase}.svg`);
  const dark = path.join(dir, `${CFG.fileBase}-dark.svg`);
  await writeFile(light, buildSvg(cal, range, 'light'), 'utf8');
  await writeFile(dark, buildSvg(cal, range, 'dark'), 'utf8');
  await writeFile(
    path.join(dir, `${CFG.fileBase}.json`),
    JSON.stringify(
      {
        user: CFG.username || (cal.demo ? 'demo' : ''),
        generatedAt: new Date().toISOString(),
        range: { from: range.from.toISOString(), to: range.to.toISOString(), label: range.label },
        totalContributions: cal.total,
        weeks: cal.weeks.length,
        demo: Boolean(cal.demo),
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(
    `${cal.demo ? '[DEMO] ' : ''}Wrote ${path.relative(process.cwd(), light)} and ` +
      `${path.relative(process.cwd(), dark)} — ${cal.total} contributions, ${cal.weeks.length} weeks.`
  );
}

main().catch((err) => {
  console.error(`generate-contributions: ${err.message}`);
  process.exit(1);
});
