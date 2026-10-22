/**
 * TroopsService
 *
 * Every troop of the account: at home, outgoing, returning and reinforcing elsewhere, from the
 * rally point overview of each village (build.php?gid=16&tt=1). The unfiltered overview stops at
 * 10 tables per section, so each section is read on its own (filter 1-4, every subfilter), page
 * after page. A troop table counts only in the village its left "role" cell names (the owner):
 * our troops between our own villages show up in both, and incoming attacks are someone else's.
 */
const SECTIONS = [
  { name: 'incoming', query: 'filter=1&subfilters=1%2C2%2C3' },
  { name: 'outgoing', query: 'filter=2&subfilters=4%2C5' },
  { name: 'home', query: 'filter=3' },
  { name: 'elsewhere', query: 'filter=4' },
];
const MAX_PAGES = 50;

const rand = ([a, b]) => a + Math.random() * (b - a);
const pause = range => new Promise(r => setTimeout(r, rand(range) * 1000));

async function page(url) {
  let res = await TravianService.request('GET', url);
  if (!TravianService.loggedIn(res.body)) {
    await TravianService.login();
    res = await TravianService.request('GET', url);
    if (!TravianService.loggedIn(res.body)) throw new TravianService.Problem('page', 'not logged in on ' + url);
  }
  return res.body;
}

const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&#0*39;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// [{ kind, owner, units: { u61: 10, uhero: 1 } }] of every troop table on a rally point page.
function tables(html) {
  const list = [];
  for (const m of html.matchAll(/<table[^>]*class="troop_details\s*([^"]*)"[\s\S]*?<\/table>/g)) {
    const role = m[0].match(/<td class="role">([\s\S]*?)<\/td>/);
    const bodies = [...m[0].matchAll(/<tbody class="units[^"]*">([\s\S]*?)<\/tbody>/g)].map(b => b[1]);
    if (!role || bodies.length < 2) continue;
    const icons = [...bodies[0].matchAll(/class="unit (u\d+|uhero)"/g)].map(i => i[1]);
    const counts = [...bodies[1].matchAll(/<td[^>]*class="unit[^"]*"[^>]*>([^<]*)</g)].map(c => Number(c[1].replace(/\D/g, '')) || 0);
    const units = {};
    icons.forEach((u, i) => { if (counts[i]) units[u] = counts[i]; });
    list.push({ kind: m[1].trim() || 'home', owner: text(role[1]), units });
  }
  return list;
}

const add = (to, units) => { for (const [u, n] of Object.entries(units)) to[u] = (to[u] || 0) + n; };

async function count({ gapSeconds = [1, 2] } = {}) {
  const { villages } = await TravianService.read();
  const total = {};
  const byVillage = {};
  const byState = {};
  const byVillageState = {};
  const pages = {};
  for (const v of villages) {
    byVillage[v.name] = {};
    byVillageState[v.name] = {};
    pages[v.name] = 0;
    for (const s of SECTIONS) {
      for (let p = 1; p <= MAX_PAGES; p++) {
        await pause(gapSeconds);
        const html = await page('/build.php?newdid=' + v.id + '&gid=16&tt=1&' + s.query + (p > 1 ? '&page=' + p : ''));
        pages[v.name]++;
        for (const t of tables(html)) {
          if (t.owner !== v.name) continue;
          const state = s.name + (t.kind === 'home' ? '' : ' ' + t.kind);
          add(total, t.units);
          add(byVillage[v.name], t.units);
          add(byState[state] || (byState[state] = {}), t.units);
          const own = byVillageState[v.name];
          add(own[state] || (own[state] = {}), t.units);
        }
        if (!html.includes('page=' + (p + 1))) break;
      }
    }
  }
  return { total, byVillage, byState, byVillageState, pages };
}

module.exports = { count, tables };
