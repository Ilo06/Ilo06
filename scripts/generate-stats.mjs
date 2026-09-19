#!/usr/bin/env node
/**
 * generate-stats.mjs
 *
 * Companion to generate-contributions.mjs. Uses the official GitHub GraphQL
 * API to produce two things:
 *
 *   1. A plain Markdown block (contributions, commits, pull requests, issues,
 *      repositories, stars) written into README.md between the markers
 *
 *          <!-- stats:start -->
 *          <!-- stats:end -->
 *
 *      Plain text on purpose: it inherits GitHub's fonts, colors and spacing,
 *      and works in light and dark mode without any extra work.
 *
 *   2. A flat "Most used languages" SVG (one file per color scheme), sized and
 *      styled to sit directly under the contribution graph.
 *
 * No dependencies. Requires Node 18+ (global fetch).
 *
 * Usage:
 *   GITHUB_USERNAME=octocat GH_TOKEN=ghp_xxx node scripts/generate-stats.mjs
 *   DEMO=1 node scripts/generate-stats.mjs      # offline render test, fake data
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  readme: env('README_PATH', 'README.md'),
  fileBase: env('LANGUAGES_BASENAME', 'languages'),

  // Public repositories only by default. Private ones need a token with `repo`
  // scope, and their languages would then appear in a public image.
  includePrivate: bool('INCLUDE_PRIVATE', false),

  // Languages
  topLanguages: Math.max(1, Math.round(num('TOP_LANGUAGES', 6))),
  columns: Math.max(1, Math.round(num('LEGEND_COLUMNS', 4))),
  excludeLanguages: list('EXCLUDE_LANGUAGES'), // e.g. "Jupyter Notebook,HTML"

  // Keep equal to the contribution graph's width so both scale identically
  // inside the README (53 weeks at the default 11px cell + 3px gap = 776).
  width: num('SVG_WIDTH', 776),
};

const THEMES = {
  // Same muted gray as the contribution graph, plus GitHub's primary text color.
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

/** Lifetime activity totals: one aliased sub-query per contribution year. */
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
    'contributionCalendar{totalContributions}';
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
  for (const y of years) {
    const c = data[`y${y}`];
    sum.contributions += c.contributionCalendar.totalContributions;
    sum.commits += c.totalCommitContributions;
    sum.pullRequests += c.totalPullRequestContributions;
    sum.issues += c.totalIssueContributions;
  }
  return sum;
}

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

/** Repositories you own (no forks): count, stars received, language sizes. */
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

async function fetchStats() {
  const [activity, repos] = await Promise.all([fetchActivity(), fetchRepositories()]);
  return { ...activity, ...repos };
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
 * README block (plain Markdown)
 * ------------------------------------------------------------------ */

const fmt = (n) => n.toLocaleString('en-US');
const count = (n, one, many) => `**${fmt(n)}** ${n === 1 ? one : many}`;

function statsMarkdown(s) {
  const scope = CFG.includePrivate ? '' : 'public ';
  return [
    `${count(s.contributions, 'contribution', 'contributions')} since ${s.since}`,
    [
      count(s.commits, 'commit', 'commits'),
      count(s.pullRequests, 'pull request', 'pull requests'),
      count(s.issues, 'issue', 'issues'),
    ].join(' · '),
    [
      count(s.repositories, `${scope}repository`, `${scope}repositories`),
      `${count(s.stars, 'star', 'stars')} received`,
    ].join(' · '),
  ].join('<br>\n');
}

async function updateReadme(block) {
  let src;
  try {
    src = await readFile(CFG.readme, 'utf8');
  } catch {
    console.warn(`generate-stats: ${CFG.readme} not found, README block skipped.`);
    return false;
  }
  const re = /(<!--\s*stats:start\s*-->)[\s\S]*?(<!--\s*stats:end\s*-->)/;
  if (!re.test(src)) {
    console.warn(
      'generate-stats: markers not found in README. Add <!-- stats:start --> and <!-- stats:end -->.'
    );
    return false;
  }
  const next = src.replace(re, (_, a, b) => `${a}\n${block}\n${b}`);
  if (next !== src) await writeFile(CFG.readme, next, 'utf8');
  return true;
}

/* ------------------------------------------------------------------ *
 * Languages SVG: one thin segmented bar + a plain legend
 * ------------------------------------------------------------------ */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r2 = (n) => Math.round(n * 100) / 100;
const safeColor = (c, fallback) => (/^#[0-9a-f]{3,8}$/i.test(c ?? '') ? c : fallback);

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
    `.t{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;` +
    `font-size:11px;fill:${t.muted}}` +
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
  for (const [theme, suffix] of [['light', ''], ['dark', '-dark']]) {
    const svg = buildLanguagesSvg(stats, theme);
    if (!svg) {
      console.warn('generate-stats: no language data, SVG skipped.');
      break;
    }
    const file = path.join(dir, `${CFG.fileBase}${suffix}.svg`);
    await writeFile(file, svg, 'utf8');
    written.push(path.relative(process.cwd(), file));
  }

  const injected = await updateReadme(statsMarkdown(stats));

  console.log(
    `${CFG.demo ? '[DEMO] ' : ''}Stats: ${fmt(stats.contributions)} contributions since ${stats.since}, ` +
      `${stats.repositories} repositories, ${stats.stars} stars. ` +
      `README block ${injected ? 'updated' : 'skipped'}; wrote ${written.join(', ') || 'no SVG'}.`
  );
}

main().catch((err) => {
  console.error(`generate-stats: ${err.message}`);
  process.exit(1);
});
