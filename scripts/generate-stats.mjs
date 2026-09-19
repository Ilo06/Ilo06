#!/usr/bin/env node
/**
 * generate-stats.mjs
 *
 * Companion to generate-contributions.mjs. Uses the official GitHub GraphQL
 * API to draw two flat, text-only SVGs (each in a light and a dark variant):
 *
 *   stats.svg      contributions, commits, pull requests, issues, repositories
 *                  (with stars received), repositories contributed to, current
 *                  streak and longest streak
 *   languages.svg  "Most used languages": one thin bar and a plain legend
 *
 * No borders, cards or backgrounds: just GitHub's font and colors, on the same
 * 776px grid as the contribution graph so all three scale identically.
 *
 * No dependencies. Requires Node 18+ (global fetch).
 *
 * Usage:
 *   GITHUB_USERNAME=octocat GH_TOKEN=ghp_xxx node scripts/generate-stats.mjs
 *   DEMO=1 node scripts/generate-stats.mjs      # offline render test, fake data
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * Configuration
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
const list = (k) =>
  env(k)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const CFG = {
  username: env('GITHUB_USERNAME'),
  token: env('GH_TOKEN') || env('GITHUB_TOKEN'),
  demo: bool('DEMO', false),

  outDir: env('OUTPUT_DIR', 'output'),
  statsBase: env('STATS_BASENAME', 'stats'),
  languagesBase: env('LANGUAGES_BASENAME', 'languages'),

  // Public repositories only by default. Private ones need a token with `repo`
  // scope, and their names/languages would then feed a public image.
  includePrivate: bool('INCLUDE_PRIVATE', false),

  // Languages
  topLanguages: Math.max(1, Math.round(num('TOP_LANGUAGES', 6))),
  columns: Math.max(1, Math.round(num('LEGEND_COLUMNS', 4))),
  excludeLanguages: list('EXCLUDE_LANGUAGES'), // e.g. "Jupyter Notebook,HTML"

  // Keep equal to the contribution graph's width so all three scale identically
  // inside the README (53 weeks at the default 11px cell + 3px gap = 776).
  width: num('SVG_WIDTH', 776),
};

const STAT_COLUMNS = 4; // same grid as the languages legend
const FONT =
  '-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif';

const THEMES = {
  // Muted gray = the contribution graph's text color; strong = GitHub's primary text.
  light: { muted: '#57606a', strong: '#1f2328', other: '#8c959f' },
  dark: { muted: '#8b949e', strong: '#e6edf3', other: '#6e7681' },
};

/* ------------------------------------------------------------------ *
 * Data: official GitHub GraphQL API
 * ------------------------------------------------------------------ */

async function gql(query, variables = {}) {
  if (!CFG.username) throw new Error('GITHUB_USERNAME is not set.');
  if (!CFG.token) throw new Error('No token found. Set GH_TOKEN (or GITHUB_TOKEN).');

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CFG.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-readme-stats',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GitHub API HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GitHub API error: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (!json.data?.user) {
    throw new Error(`User "${CFG.username}" not found or not visible to this token.`);
  }
  return json.data.user;
}

/* ---- streaks ------------------------------------------------------- */

const DAY = 864e5;
const toMs = (iso) => Date.parse(`${iso}T00:00:00Z`);

/**
 * `days` maps "YYYY-MM-DD" -> contribution count (every day of every year).
 * A streak is a run of consecutive days with at least one contribution. The
 * current streak stays alive if today is still empty but yesterday counted.
 */
function computeStreaks(days) {
  const dates = [...days.keys()].sort();
  const empty = { length: 0, start: null, end: null };
  if (!dates.length) return { currentStreak: empty, longestStreak: empty };

  const runs = [];
  let run = null;
  for (const d of dates) {
    if ((days.get(d) ?? 0) <= 0) {
      run = null;
      continue;
    }
    if (run && toMs(d) - toMs(run.end) === DAY) {
      run.end = d;
      run.length += 1;
    } else {
      run = { start: d, end: d, length: 1 };
      runs.push(run);
    }
  }

  const longest = runs.reduce((best, r) => (r.length >= best.length ? r : best), empty);

  const today = dates.at(-1);
  const last = runs.at(-1);
  const alive = last && (last.end === today || toMs(today) - toMs(last.end) === DAY);

  return { currentStreak: alive ? last : empty, longestStreak: longest };
}

/* ---- lifetime activity + streaks ----------------------------------- */

async function fetchActivity() {
  const head = await gql(
    `query($login:String!){user(login:$login){contributionsCollection{contributionYears}}}`,
    { login: CFG.username }
  );
  const years = head.contributionsCollection.contributionYears
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  if (!years.length) throw new Error('No contribution years returned.');

  const now = new Date();
  const fields =
    'totalCommitContributions totalPullRequestContributions totalIssueContributions ' +
    'contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}';
  const aliases = years
    .map((y) => {
      const end = new Date(Date.UTC(y, 11, 31, 23, 59, 59));
      const to = (end > now ? now : end).toISOString();
      return `y${y}:contributionsCollection(from:"${y}-01-01T00:00:00Z",to:"${to}"){${fields}}`;
    })
    .join('\n');
  const data = await gql(`query($login:String!){user(login:$login){${aliases}}}`, {
    login: CFG.username,
  });

  const sum = { since: years[0], contributions: 0, commits: 0, pullRequests: 0, issues: 0 };
  const days = new Map();
  for (const y of years) {
    const c = data[`y${y}`];
    sum.contributions += c.contributionCalendar.totalContributions;
    sum.commits += c.totalCommitContributions;
    sum.pullRequests += c.totalPullRequestContributions;
    sum.issues += c.totalIssueContributions;
    for (const w of c.contributionCalendar.weeks) {
      for (const d of w.contributionDays) {
        days.set(d.date, Math.max(days.get(d.date) ?? 0, d.contributionCount));
      }
    }
  }
  return { ...sum, ...computeStreaks(days) };
}

/* ---- repositories: count, stars, languages ------------------------- */

const REPOS_QUERY = `
query($login:String!,$after:String,$privacy:RepositoryPrivacy){
  user(login:$login){
    repositories(first:100,after:$after,ownerAffiliations:OWNER,isFork:false,privacy:$privacy){
      pageInfo{hasNextPage endCursor}
      nodes{
        stargazerCount
        languages(first:10,orderBy:{field:SIZE,direction:DESC}){
          edges{size node{name color}}
        }
      }
    }
  }
}`;

async function fetchRepositories() {
  const repos = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const user = await gql(REPOS_QUERY, {
      login: CFG.username,
      after,
      privacy: CFG.includePrivate ? null : 'PUBLIC',
    });
    repos.push(...user.repositories.nodes);
    if (!user.repositories.pageInfo.hasNextPage) break;
    after = user.repositories.pageInfo.endCursor;
  }

  const langs = new Map();
  let stars = 0;
  for (const r of repos) {
    stars += r.stargazerCount;
    for (const { size, node } of r.languages.edges) {
      if (CFG.excludeLanguages.includes(node.name.toLowerCase())) continue;
      const cur = langs.get(node.name) ?? { name: node.name, color: node.color, size: 0 };
      cur.size += size;
      langs.set(node.name, cur);
    }
  }
  return { repositories: repos.length, stars, languages: [...langs.values()] };
}

/* ---- repositories you contributed to (not owned by you) ------------ */

const CONTRIBUTED_QUERY = `
query($login:String!,$privacy:RepositoryPrivacy){
  user(login:$login){
    repositoriesContributedTo(
      first:1,privacy:$privacy,includeUserRepositories:false,
      contributionTypes:[COMMIT,ISSUE,PULL_REQUEST,REPOSITORY]
    ){totalCount}
  }
}`;

async function fetchContributedTo() {
  const user = await gql(CONTRIBUTED_QUERY, {
    login: CFG.username,
    privacy: CFG.includePrivate ? null : 'PUBLIC',
  });
  return user.repositoriesContributedTo.totalCount;
}

/**
 * Optional data must never take the whole image down: if it fails (missing
 * token scope, API hiccup), log a warning, show "—" and keep going.
 */
async function optional(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`::warning title=generate-stats::${label} skipped: ${err.message}`);
    return fallback;
  }
}

async function fetchStats() {
  const [activity, repos, contributedTo] = await Promise.all([
    fetchActivity(), // required: contributions, commits, PRs, issues, streaks
    optional('repositories, stars and languages', fetchRepositories, {
      repositories: null,
      stars: null,
      languages: [],
    }),
    optional('contributed-to count', fetchContributedTo, null),
  ]);
  return { ...activity, ...repos, contributedTo };
}

/** Fake numbers, ONLY for local rendering tests (DEMO=1). */
function demoStats() {
  return {
    since: 2023,
    contributions: 2431,
    commits: 1867,
    pullRequests: 74,
    issues: 19,
    repositories: 23,
    stars: 48,
    contributedTo: 14,
    currentStreak: { length: 12, start: '2026-09-08', end: '2026-09-19' },
    longestStreak: { length: 41, start: '2025-03-02', end: '2025-04-11' },
    languages: [
      { name: 'TypeScript', color: '#3178c6', size: 380 },
      { name: 'Java', color: '#b07219', size: 270 },
      { name: 'Python', color: '#3572A5', size: 140 },
      { name: 'JavaScript', color: '#f1e05a', size: 90 },
      { name: 'CSS', color: '#663399', size: 52 },
      { name: 'HTML', color: '#e34c26', size: 40 },
      { name: 'Shell', color: '#89e051', size: 18 },
      { name: 'Dockerfile', color: '#384d54', size: 10 },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r2 = (n) => Math.round(n * 100) / 100;
const safeColor = (c, fallback) => (/^#[0-9a-f]{3,8}$/i.test(c ?? '') ? c : fallback);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(iso, withYear) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}

/** "Sep 8 – Sep 19", "Mar 2 – Apr 11, 2025", "Dec 20, 2024 – Jan 3, 2025" */
function fmtRange(start, end) {
  const thisYear = String(new Date().getUTCFullYear());
  const ys = start.slice(0, 4);
  const ye = end.slice(0, 4);
  if (start === end) return fmtDate(start, ys !== thisYear);
  if (ys !== ye) return `${fmtDate(start, true)} – ${fmtDate(end, true)}`;
  return `${fmtDate(start, false)} – ${fmtDate(end, ys !== thisYear)}`;
}

/* ------------------------------------------------------------------ *
 * Stats SVG: label, number, one line of detail. No boxes, no lines.
 * ------------------------------------------------------------------ */

function buildStatsSvg(s, theme) {
  const t = THEMES[theme];
  const PAD = 4;
  const inner = CFG.width - PAD * 2;
  const colW = inner / STAT_COLUMNS;
  const rowPitch = 70;
  const scope = CFG.includePrivate ? '' : 'Public ';
  const n = (v) => (v == null ? '—' : fmt(v));

  const streak = (label, st) => ({
    label,
    value: fmt(st.length),
    unit: st.length === 1 ? 'day' : 'days',
    sub: st.length ? fmtRange(st.start, st.end) : '',
  });

  const items = [
    { label: 'Contributions', value: fmt(s.contributions), sub: `since ${s.since}` },
    { label: 'Commits', value: fmt(s.commits) },
    { label: 'Pull requests', value: fmt(s.pullRequests) },
    { label: 'Issues', value: fmt(s.issues) },
    {
      label: `${scope}repositories`.replace(/^./, (c) => c.toUpperCase()),
      value: n(s.repositories),
      sub: s.stars == null ? '' : `${fmt(s.stars)} ${s.stars === 1 ? 'star' : 'stars'} received`,
    },
    {
      label: 'Contributed to',
      value: n(s.contributedTo),
      sub: s.contributedTo == null ? '' : 'other repositories',
    },
    streak('Current streak', s.currentStreak),
    streak('Longest streak', s.longestStreak),
  ];

  const rows = Math.ceil(items.length / STAT_COLUMNS);
  const height = r2(PAD + (rows - 1) * rowPitch + 51 + PAD + 3);

  const css =
    `.t,.v{font-family:${FONT};font-size:11px;fill:${t.muted}}` +
    `.v{font-size:20px;font-weight:600;fill:${t.strong}}` +
    `.u{font-size:11px;font-weight:400;fill:${t.muted}}`;

  const cells = items.map((it, i) => {
    const x = r2(PAD + (i % STAT_COLUMNS) * colW);
    const y0 = PAD + Math.floor(i / STAT_COLUMNS) * rowPitch;
    return (
      `<text class="t" x="${x}" y="${y0 + 12}">${esc(it.label)}</text>` +
      `<text class="v" x="${x}" y="${y0 + 35}">${esc(it.value)}` +
      (it.unit ? `<tspan class="u" dx="4">${it.unit}</tspan>` : '') +
      `</text>` +
      (it.sub ? `<text class="t" x="${x}" y="${y0 + 51}">${esc(it.sub)}</text>` : '')
    );
  });

  const desc = items
    .map((it) => `${it.label} ${it.value}${it.unit ? ` ${it.unit}` : ''}${it.sub ? ` (${it.sub})` : ''}`)
    .join('; ');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CFG.width}" height="${height}" ` +
    `viewBox="0 0 ${CFG.width} ${height}" role="img" aria-labelledby="ttl dsc" ` +
    `preserveAspectRatio="xMidYMid meet">` +
    `<title id="ttl">${esc(CFG.username || 'demo')}'s GitHub statistics</title>` +
    `<desc id="dsc">${esc(desc)}</desc>` +
    `<style>${css}</style>${cells.join('')}</svg>`
  );
}

/* ------------------------------------------------------------------ *
 * Languages SVG: one thin segmented bar + a plain legend
 * ------------------------------------------------------------------ */

function buildLanguagesSvg(stats, theme) {
  const t = THEMES[theme];
  const total = stats.languages.reduce((a, l) => a + l.size, 0);
  if (!total) return null;

  const sorted = [...stats.languages].sort((a, b) => b.size - a.size);
  const items = sorted.slice(0, CFG.topLanguages).map((l) => ({
    name: l.name,
    color: safeColor(l.color, t.other),
    size: l.size,
  }));
  const rest = sorted.slice(CFG.topLanguages).reduce((a, l) => a + l.size, 0);
  if (rest > 0) items.push({ name: 'Other', color: t.other, size: rest });

  const PAD = 4; // same outer padding as the contribution graph
  const inner = CFG.width - PAD * 2;
  const titleY = 16.1; // same baseline as the graph's title
  const barY = 26;
  const barH = 8;
  const gap = 2;
  const rowH = 20;
  const firstRow = barY + barH + 22;
  const rows = Math.ceil(items.length / CFG.columns);
  const height = r2(firstRow + (rows - 1) * rowH + PAD + 4);

  const css =
    `.t{font-family:${FONT};font-size:11px;fill:${t.muted}}` +
    `.b{font-size:11.55px;font-weight:600}` +
    `.n{fill:${t.strong};font-weight:600}`;

  let cum = 0;
  const bar = items.map((it) => {
    const share = it.size / total;
    const x = PAD + cum * inner;
    cum += share;
    const w = Math.max(share * inner - gap, 1.5);
    return `<rect x="${r2(x)}" y="${barY}" width="${r2(w)}" height="${barH}" fill="${it.color}"/>`;
  });

  const colW = inner / CFG.columns;
  const legend = items.map((it, i) => {
    const x = PAD + (i % CFG.columns) * colW;
    const y = firstRow + Math.floor(i / CFG.columns) * rowH;
    const share = (it.size / total) * 100;
    const pct = share < 0.1 ? '<0.1%' : `${share.toFixed(1)}%`;
    return (
      `<circle cx="${r2(x + 4)}" cy="${r2(y - 3.8)}" r="4" fill="${it.color}"/>` +
      `<text class="t" x="${r2(x + 14)}" y="${y}"><tspan class="n">${esc(it.name)}</tspan>` +
      `<tspan dx="6">${esc(pct)}</tspan></text>`
    );
  });

  const desc = items
    .map((it) => `${it.name} ${((it.size / total) * 100).toFixed(1)}%`)
    .join(', ');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CFG.width}" height="${height}" ` +
    `viewBox="0 0 ${CFG.width} ${height}" role="img" aria-labelledby="ttl dsc" ` +
    `preserveAspectRatio="xMidYMid meet">` +
    `<title id="ttl">Most used languages</title><desc id="dsc">${esc(desc)}</desc>` +
    `<style>${css}</style>` +
    `<text class="t b" x="${PAD}" y="${titleY}">Most used languages</text>` +
    `<g>${bar.join('')}</g><g>${legend.join('')}</g></svg>`
  );
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const stats = CFG.demo ? demoStats() : await fetchStats();

  const dir = path.resolve(process.cwd(), CFG.outDir);
  await mkdir(dir, { recursive: true });

  const written = [];
  const jobs = [
    [CFG.statsBase, buildStatsSvg],
    [CFG.languagesBase, buildLanguagesSvg],
  ];
  for (const [base, build] of jobs) {
    for (const [theme, suffix] of [['light', ''], ['dark', '-dark']]) {
      const svg = build(stats, theme);
      if (!svg) {
        console.warn(`generate-stats: no data for ${base}, SVG skipped.`);
        break;
      }
      const file = path.join(dir, `${base}${suffix}.svg`);
      await writeFile(file, svg, 'utf8');
      written.push(path.relative(process.cwd(), file));
    }
  }

  console.log(
    `${CFG.demo ? '[DEMO] ' : ''}Stats: ${fmt(stats.contributions)} contributions since ${stats.since}, ` +
      `streak ${stats.currentStreak.length}/${stats.longestStreak.length} days. Wrote ${written.join(', ')}.`
  );
}

main().catch((err) => {
  console.error(`generate-stats: ${err.message}`);
  process.exit(1);
});
