// Draws the "On GitHub" card for the profile README, in the colours and type of sidneyb.uk, from GitHub's own
// numbers. Run by .github/workflows/stats.yml once a day; writes assets/stats-dark.svg and assets/stats-light.svg.
//
//   GITHUB_TOKEN   the workflow's own token: public repositories and activity only
//   STATS_TOKEN    a personal token (classic) with the repo and read:user scopes: private repositories, their
//                  languages and private contributions are counted too. Only totals are drawn; no private
//                  repository is named on the card.
//   MOCK           optional: a JSON file of made-up data, to try the drawing without asking GitHub
//
// No packages: plain Node 20 or later.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USER = process.env.STATS_USER || "onlysid";
// Left out of the languages, as on the old cards.
const HIDE_LANGS = ["jupyter notebook", "tex", "css", "php"];
const HIDE_REPOS = ["Pacman-AI"];

const PRIVATE = !!process.env.STATS_TOKEN && !process.env.MOCK;
const QUERY = `query($login: String!, $after: String) {
  user(login: $login) {
    contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } }
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false${PRIVATE ? "" : ", privacy: PUBLIC"}, orderBy: { field: PUSHED_AT, direction: DESC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { name isPrivate stargazerCount languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } } }
    }
  }
}`;

async function load() {
  if (process.env.MOCK) return JSON.parse(readFileSync(process.env.MOCK, "utf8"));
  const token = process.env.STATS_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("No token: set GITHUB_TOKEN (the workflow does this) or STATS_TOKEN.");
  if (!PRIVATE) console.log("No STATS_TOKEN secret: counting public repositories only.");
  const ask = async (after) => {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": `${USER}-profile-stats` },
      body: JSON.stringify({ query: QUERY, variables: { login: USER, after } }),
    });
    const body = await res.json();
    if (!res.ok || body.errors) throw new Error(`GitHub said: ${JSON.stringify(body.errors ?? body)}`);
    return body.data.user;
  };
  // Every repository, a hundred at a time.
  const user = await ask(null);
  for (let page = user.repositories.pageInfo; page.hasNextPage; ) {
    const more = await ask(page.endCursor);
    user.repositories.nodes.push(...more.repositories.nodes);
    page = more.repositories.pageInfo;
  }
  return user;
}

// ---- The numbers -----------------------------------------------------------------------------------------------
function numbers(user) {
  const cal = user.contributionsCollection.contributionCalendar;
  const days = cal.weeks.flatMap((w) => w.contributionDays);
  // The current streak may not have today in it yet: today with nothing so far does not break it.
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) current++;
    else if (i === days.length - 1) continue;
    else break;
  }
  let longest = 0;
  let run = 0;
  for (const d of days) longest = Math.max(longest, (run = d.contributionCount > 0 ? run + 1 : 0));
  const repos = user.repositories.nodes.filter((r) => !HIDE_REPOS.includes(r.name));
  const stars = repos.reduce((n, r) => n + r.stargazerCount, 0);
  const sizes = new Map();
  for (const r of repos)
    for (const e of r.languages.edges) {
      if (HIDE_LANGS.includes(e.node.name.toLowerCase())) continue;
      sizes.set(e.node.name, (sizes.get(e.node.name) ?? 0) + e.size);
    }
  const total = [...sizes.values()].reduce((a, b) => a + b, 0) || 1;
  let langs = [...sizes].sort((a, b) => b[1] - a[1]).map(([name, size]) => ({ name, share: size / total }));
  if (langs.length > 6) langs = [...langs.slice(0, 5), { name: "Other", share: langs.slice(5).reduce((a, l) => a + l.share, 0) }];
  const hidden = user.repositories.nodes.filter((r) => r.isPrivate).length;
  return { weeks: cal.weeks, total: cal.totalContributions, current, longest, repos: user.repositories.totalCount, hidden, stars, langs };
}

// ---- The drawing -----------------------------------------------------------------------------------------------
const THEMES = {
  dark: {
    bg: "#100c15", text: "#f3eef2", muted: "#a79bb2", accent: "#ddb3cb", edge: "rgba(255,255,255,0.10)", glass: "rgba(255,255,255,0.04)",
    blobs: ["rgba(221,179,203,0.22)", "rgba(104,71,128,0.55)", "rgba(168,120,170,0.24)"],
    cells: ["rgba(255,255,255,0.06)", "#4a3360", "#7a5590", "#b184b8", "#ecc6dc"],
    langs: ["#ddb3cb", "#b184b8", "#8a66a3", "#684780", "#4a3360", "#3b3243"],
    sheen: ["#ddb3cb", "#a878aa"],
  },
  light: {
    bg: "#f3eef2", text: "#201a26", muted: "#645868", accent: "#684780", edge: "rgba(104,71,128,0.20)", glass: "rgba(255,255,255,0.55)",
    blobs: ["rgba(221,179,203,0.75)", "rgba(168,120,170,0.45)", "rgba(138,102,163,0.38)"],
    cells: ["rgba(104,71,128,0.08)", "#ecc6dc", "#c58fb4", "#8a66a3", "#4a3360"],
    langs: ["#684780", "#8a66a3", "#a878aa", "#c58fb4", "#ddb3cb", "#e4dbe6"],
    sheen: ["#a878aa", "#684780"],
  },
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const font = (file) => readFileSync(join(ROOT, "assets", "fonts", file)).toString("base64");
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function draw(n, t, fonts, today) {
  const W = 1280;
  const pad = 64;
  // The year of days: a column a week, a row a weekday.
  const cell = 17;
  const gap = 4;
  const weeks = n.weeks.slice(-53);
  const counts = weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount)).filter((c) => c > 0).sort((a, b) => a - b);
  const q = (p) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))] ?? 1;
  const level = (c) => (c <= 0 ? 0 : c <= q(0.25) ? 1 : c <= q(0.5) ? 2 : c <= q(0.8) ? 3 : 4);
  const gridW = weeks.length * (cell + gap) - gap;
  const gx = (W - gridW) / 2;
  const gy = 250;
  let grid = "";
  let months = "";
  let lastMonth = -1;
  let lastAt = -9;
  weeks.forEach((w, i) => {
    const first = w.contributionDays[0];
    const m = Number(first.date.slice(5, 7)) - 1;
    // A label where each month starts, unless the last one is too close (the first, part-month, column).
    if (m !== lastMonth) {
      if (i - lastAt >= 3 && i < weeks.length - 2 && (i > 0 || Number(first.date.slice(8)) <= 7)) {
        months += `<text class="mono" x="${gx + i * (cell + gap)}" y="${gy - 14}">${MONTHS[m]}</text>`;
        lastAt = i;
      }
      lastMonth = m;
    }
    for (const d of w.contributionDays) {
      const row = new Date(`${d.date}T00:00:00Z`).getUTCDay();
      grid += `<rect x="${gx + i * (cell + gap)}" y="${gy + row * (cell + gap)}" width="${cell}" height="${cell}" rx="4.5" fill="${t.cells[level(d.contributionCount)]}"><title>${d.contributionCount} on ${d.date}</title></rect>`;
    }
  });
  const gridH = 7 * (cell + gap) - gap;

  // The numbers across the top, like the stats on the site's sport pages.
  const stats = [
    [n.total.toLocaleString("en-GB"), "contributions, last year"],
    [`${n.current}`, n.current === 1 ? "day streak now" : "day streak now"],
    [`${n.longest}`, "longest streak, days"],
    [`${n.repos}`, n.hidden ? `repositories, ${n.hidden} private` : n.repos === 1 ? "public repository" : "public repositories"],
  ];
  const colW = (W - pad * 2) / stats.length;
  const statSvg = stats
    .map(([v, l], i) => `<g transform="translate(${pad + i * colW} 0)"><text class="big" x="0" y="150" fill="url(#sheen)">${esc(v)}</text><text class="mono" x="2" y="186">${esc(l.toUpperCase())}</text></g>`)
    .join("");

  // Languages: one rounded bar, then a key.
  const by = gy + gridH + 74;
  const barW = W - pad * 2;
  let x = pad;
  const bar = n.langs
    .map((l, i) => {
      const w = Math.max(3, l.share * barW);
      const s = `<rect x="${x.toFixed(1)}" y="${by}" width="${(w - (i < n.langs.length - 1 ? 3 : 0)).toFixed(1)}" height="14" fill="${t.langs[i % t.langs.length]}"/>`;
      x += w;
      return s;
    })
    .join("");
  let kx = pad;
  const key = n.langs
    .map((l, i) => {
      const label = `${l.name} ${Math.round(l.share * 100)}%`;
      const s = `<g transform="translate(${kx} ${by + 50})"><circle cx="6" cy="-6" r="6" fill="${t.langs[i % t.langs.length]}"/><text class="body" x="20" y="0">${esc(l.name)} <tspan fill="${t.muted}">${Math.round(l.share * 100)}%</tspan></text></g>`;
      kx += 40 + label.length * 11.2;
      return s;
    })
    .join("");
  const H = by + 100;
  const stamp = `UPDATED ${today.getUTCDate()} ${MONTHS[today.getUTCMonth()]} ${today.getUTCFullYear()}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${n.total} contributions in the last year; a ${n.current} day streak; ${n.repos} repositories${n.hidden ? `, ${n.hidden} of them private` : ""}. Most used: ${n.langs.map((l) => l.name).join(", ")}.`)}">
<defs>
<style>
@font-face{font-family:D;src:url(data:font/woff2;base64,${fonts.display}) format("woff2");font-weight:600}
@font-face{font-family:B;src:url(data:font/woff2;base64,${fonts.body}) format("woff2");font-weight:500}
@font-face{font-family:M;src:url(data:font/woff2;base64,${fonts.mono}) format("woff2");font-weight:500}
.big{font-family:D,system-ui,sans-serif;font-weight:600;font-size:64px;letter-spacing:-2px}
.body{font-family:B,system-ui,sans-serif;font-weight:500;font-size:19px;fill:${t.text}}
.mono{font-family:M,ui-monospace,monospace;font-weight:500;font-size:14px;letter-spacing:2.6px;fill:${t.muted}}
.label{fill:${t.accent}}
.blob{animation:drift 20s ease-in-out infinite alternate}
.b2{animation-duration:26s;animation-direction:alternate-reverse}
@keyframes drift{from{transform:translate(0,0)}to{transform:translate(80px,30px)}}
@media (prefers-reduced-motion:reduce){.blob{animation:none}}
</style>
<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="60"/></filter>
<clipPath id="card"><rect width="${W}" height="${H}" rx="36"/></clipPath>
<clipPath id="bar"><rect x="${pad}" y="${by}" width="${barW}" height="14" rx="7"/></clipPath>
<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.sheen[0]}"/><stop offset="1" stop-color="${t.sheen[1]}"/></linearGradient>
</defs>
<g clip-path="url(#card)">
<rect width="${W}" height="${H}" fill="${t.bg}"/>
<g filter="url(#soft)">
<circle class="blob" cx="1040" cy="40" r="180" fill="${t.blobs[0]}"/>
<circle class="blob b2" cx="180" cy="${H}" r="220" fill="${t.blobs[1]}"/>
<circle class="blob" cx="1180" cy="${H - 40}" r="160" fill="${t.blobs[2]}"/>
</g>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="35" fill="${t.glass}" stroke="${t.edge}" stroke-width="2"/>
</g>
<text class="mono label" x="${pad}" y="76">ON GITHUB · @${esc(USER.toUpperCase())}</text>
<text class="mono" x="${W - pad}" y="76" text-anchor="end">${stamp}</text>
${statSvg}
${months}
${grid}
<g clip-path="url(#bar)"><rect x="${pad}" y="${by}" width="${barW}" height="14" fill="${t.cells[0]}"/>${bar}</g>
<text class="mono label" x="${pad}" y="${by - 18}">MOST USED</text>
${key}
</svg>`;
}

const user = await load();
const n = numbers(user);
const fonts = { display: font("display.woff2"), body: font("body.woff2"), mono: font("mono.woff2") };
const today = process.env.MOCK_TODAY ? new Date(process.env.MOCK_TODAY) : new Date();
for (const [name, t] of Object.entries(THEMES)) writeFileSync(join(ROOT, "assets", `stats-${name}.svg`), draw(n, t, fonts, today));
console.log(`Drew the card: ${n.total} contributions, streak ${n.current} (longest ${n.longest}), ${n.repos} repositories, ${n.langs.map((l) => l.name).join(", ")}.`);
