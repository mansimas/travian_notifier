/**
 * AutoRaidService
 *
 * Raids oases from the villages in sails.config.travian.autoRaid.villages, round after round,
 * every minMinutes..maxMinutes at random, unless stopped (GET /stop, /start). One round:
 *  1. troops at home in each village (rally point send form); villages with too few skip 2-4;
 *  2. outgoing troops of all those villages: an oasis with a raid on its way gets no other;
 *  3. the never-owned oases of each village's first stages (OasisService scan), animals from
 *     map blocks; one chosen oasis is checked against tile-details:
 *     - mode 'empty': empty oases our last raid hit at least restMinutes ago, closest first,
 *       perStage[stage] Mercenaries each, as long as that many are at home; all chosen ones are
 *       checked if the first differs;
 *     - mode 'animals': oases with animals, armies by RaidPlanService (cavOnly: the horses
 *       alone, going on with the oases the entries before left over); no horses where our raids
 *       hit less than horseRestMinutes ago; with enough horses left over one stage more is loaded and planned again, up to maxStages; if the check
 *       differs, every chosen oasis is asked one by one and the plan made again;
 *     - mode 'natars': no oases; `per` v.unit to each Natar village within `radius` fields
 *       (OasisService.natars) with no raid of ours on its way, closest first; by the Natar
 *       reports a poor village is left alone for a while and a rich one gets more, more often
 *       (natarTarget);
 *  4. the raids are sent, with what was planned (for the evaluation in /autoraid);
 *  5. the newest oasis and Natar raid reports (read or not) are kept and matched to the raids sent; the
 *     ones that were unread are marked unread again, so you still see them as new in the game.
 * With send off (dry run) step 4 only logs what it would send, and step 5 is left out.
 * Troops sent by one entry are taken off what the next entries of that village see at home.
 * Kept in .tmp/autoraid.json: raids sent, reports read (Natar ones apart), Natar villages left
 * alone, stopped or not, the last round.
 */
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(process.cwd(), '.tmp', 'autoraid.json');
const KEEP = 2000; // raids and reports kept
const MAX_BLOCKS = 12;
const MAX_REPORTS_PER_ROUND = 15;
const MAX_OUTGOING_PAGES = 20;
const MINUTE = 60 * 1000;

const EMPTY_STATE = { raids: [], reports: [], natarReports: [], natarSkip: {}, lastRound: null, stopped: false, cavStopped: false };
let state = { ...EMPTY_STATE };

function readState() {
  try { state = { ...EMPTY_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (e) { /* first run */ }
}

function writeState() {
  state.raids = state.raids.slice(-KEEP);
  state.reports = state.reports.slice(-KEEP);
  state.natarReports = state.natarReports.slice(-KEEP);
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

const cfg = () => sails.config.travian.autoRaid;
const rand = ([a, b]) => a + Math.random() * (b - a);
const pause = range => new Promise(r => setTimeout(r, rand(range) * 1000));

// A game page; logs in again when the session has run out.
async function page(method, url, opts = {}) {
  let res = await TravianService.request(method, url, opts);
  if (!TravianService.loggedIn(res.body)) {
    await TravianService.login();
    res = await TravianService.request(method, url, opts);
    if (!TravianService.loggedIn(res.body)) throw new TravianService.Problem('page', 'not logged in on ' + url);
  }
  return res.body;
}

// Plain text of game html: tags out, coordinate marks and minus signs made plain.
function plain(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&minus;|\u2212/g, '-').replace(/&#x202[a-e];|[\u202a-\u202e\u200e\u200f]/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&#0*39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

const coordsIn = text => {
  const m = text.match(/\(\s*(-?\d+)\s*\|\s*(-?\d+)\s*\)/);
  return m ? Number(m[1]) + '|' + Number(m[2]) : null;
};

// Units of `slot` (1-11) the send form says are at home.
function available(formHtml, slot) {
  const at = formHtml.indexOf('name="troop[t' + slot + ']"');
  if (at < 0) return 0;
  const next = formHtml.indexOf('name="troop[t', at + 10);
  const m = formHtml.slice(at, next < 0 ? undefined : next).match(/\.val\((\d+)\)/);
  return m ? Number(m[1]) : 0;
}

// Oases ("x|y") outgoing troops of a village are on their way to (rally point, outgoing).
function outgoingTargets(html) {
  const keys = [];
  for (const m of html.matchAll(/<table[^>]*class="troop_details (out\w*)[^"]*"[\s\S]*?<\/table>/g)) {
    const head = m[0].match(/class="troopHeadline"[\s\S]*?<\/td>/);
    const key = head && coordsIn(plain(head[0]));
    if (key) keys.push(key);
  }
  return keys;
}

// Map blocks until every oasis in keys was in one: key -> tile.
async function blocksFor(village, keys) {
  const tiles = new Map();
  const missing = () => keys.filter(k => !tiles.has(k));
  let center = { x: village.x, y: village.y };
  for (let i = 0; i < MAX_BLOCKS && center; i++) {
    if (i) await pause(cfg().pageGapSeconds);
    const reply = await OasisService.requestBlock(center.x, center.y);
    for (const t of (reply && reply.tiles) || []) {
      const key = t.position.x + '|' + t.position.y;
      if (keys.includes(key)) tiles.set(key, t);
    }
    const next = missing()[0];
    center = next ? { x: Number(next.split('|')[0]), y: Number(next.split('|')[1]) } : null;
  }
  return tiles;
}

const slotOf = unit => Number(unit.slice(1)) % 10 || 10; // u61 -> 1, u70 -> 10

// Confirmation page -> { body, arrival } for the final post, or throws. army: { uNN: n }.
// owner: who the target must still belong to (Nature for an oasis, Natars for a Natar village).
function confirmForm(html, army, owner = 'Nature') {
  const at = html.indexOf('id="troopSendForm"');
  if (at < 0) {
    const err = html.match(/class="error[^"]*"[^>]*>([\s\S]*?)<\//);
    throw new Error('no confirmation page' + (err ? ': ' + plain(err[1]).trim() : ''));
  }
  const form = html.slice(html.lastIndexOf('<form', at), html.indexOf('</form>', at));
  if (!plain(form).includes(owner)) throw new Error('target is not ' + owner + ' any more');
  const fields = [...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1], m[2]]);
  for (let slot = 1; slot <= 10; slot++) {
    const want = Object.entries(army).filter(([u]) => slotOf(u) === slot).reduce((s, [, n]) => s + n, 0);
    const sent = fields.find(([k]) => k === 'troops[0][t' + slot + ']');
    if (Number(sent ? sent[1] : 0) !== want) throw new Error('confirmation shows ' + (sent ? sent[1] : 0) + ' in slot t' + slot + ' instead of ' + want);
  }
  const checksum = (html.match(/input\[name=checksum\]'\)\.value = '([^']+)'/) || [])[1];
  if (!checksum) throw new Error('no checksum on the confirmation page');
  const body = new URLSearchParams(fields.map(([k, v]) => [k, k === 'checksum' ? checksum : v.replace(/&amp;/g, '&')])).toString();
  const arrival = Number((html.match(/id="at"[^>]*value="(\d+)"/) || [])[1]) || null;
  return { body, arrival };
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function sendRaid(village, key, army, owner) {
  const [x, y] = key.split('|');
  await page('GET', '/build.php?newdid=' + village.id + '&gid=16&tt=2&eventType=4&x=' + x + '&y=' + y);
  await pause(cfg().pageGapSeconds);
  const p = new URLSearchParams();
  for (let i = 1; i <= 11; i++) p.set('troop[t' + i + ']', '');
  for (const [u, n] of Object.entries(army)) p.set('troop[t' + slotOf(u) + ']', String(n));
  p.set('villagename', ''); p.set('x', x); p.set('y', y); p.set('eventType', '4'); p.set('ok', 'ok');
  const confirm = await page('POST', '/build.php?gid=16&tt=2', { body: p.toString(), headers: FORM });
  const { body, arrival } = confirmForm(confirm, army, owner);
  await pause(cfg().pageGapSeconds);
  const done = await page('POST', '/build.php?gid=16&tt=2', { body, headers: FORM });
  if (done.includes('id="confirmSendTroops"')) throw new Error('the game did not accept the send');
  return arrival;
}

// ---- reports -------------------------------------------------------------------------------

// Numbers of a units row ("{units} 7 0 0 ...").
const rowNumbers = row => (plain(row).match(/-?\d[\d,]*/g) || []).map(s => Number(s.replace(/,/g, '')));

// Unit rows after the header row listing `first` (e.g. u61): [[n x 10/11], ...].
function unitRows(html, first) {
  const at = html.indexOf('class="unit ' + first + '"');
  if (at < 0) return [];
  const rows = [];
  const rest = html.slice(html.indexOf('</tbody>', at));
  for (const m of rest.matchAll(/<tbody class="units[^"]*">([\s\S]*?)<\/tbody>/g)) {
    if (/class="unit u\d+"/.test(m[1])) break; // next header: other side
    rows.push(rowNumbers(m[1]));
  }
  return rows;
}

const toCounts = (units, row) => Object.fromEntries((row || []).slice(0, units.length).map((n, i) => [units[i], n]).filter(([, n]) => n > 0));

function parseReport(html, id) {
  const start = html.indexOf('id="reportWrapper"');
  const body = html.slice(start, start + 60000);
  const text = plain(body);
  const title = text.match(/(\S+) raids Unoccupied oasis \(\s*(-?\d+)\s*\|\s*(-?\d+)\s*\)/)
    || text.match(/(\S+) raids (Natars) (-?\d+)\|(-?\d+)/);
  if (!title) return null;
  const natars = title[2] === 'Natars';
  if (natars) title.splice(2, 1);
  const own = Array.from({ length: 10 }, (_, i) => 'u' + (61 + i));
  const nature = Array.from({ length: 10 }, (_, i) => 'u' + (31 + i));
  const att = unitRows(body, 'u61');
  const def = unitRows(body, 'u31');
  const bounty = text.match(/Bounty ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+)\s*\/\s*([\d,]+)/);
  const hero = text.match(/killing animals\. ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+)/);
  const num = s => Number(String(s).replace(/,/g, ''));
  return {
    id,
    village: title[1],
    key: num(title[2]) + '|' + num(title[3]),
    time: (text.match(/(\d\d\.\d\d\.\d\d, \d\d:\d\d:\d\d)/) || [])[1] || null,
    sent: toCounts(own, att[0]),
    dead: toCounts(own, att[1]),
    found: toCounts(nature, def[0]),
    killed: toCounts(nature, def[1]),
    bounty: bounty ? [1, 2, 3, 4].reduce((s, i) => s + num(bounty[i]), 0) : 0,
    carried: bounty ? num(bounty[5]) : null,
    capacity: bounty ? num(bounty[6]) : null,
    heroBonus: hero ? [1, 2, 3, 4].reduce((s, i) => s + num(hero[i]), 0) : 0,
    ...(natars ? { natars: true, found: {}, killed: {} } : {}),
    at: Date.now(),
  };
}

// Marks these reports (ids as "221576689|f5f28980") unread again, as the list's read/unread
// toggle does. Opening a report marks it read; this puts back what the player has not seen yet.
async function markUnread(ids) {
  if (!ids.length) return;
  const send = () => TravianService.request('PUT', '/api/v1/report/update-status', {
    body: JSON.stringify({ ids: ids.map(id => id.split('|')[0]), status: 'unread' }),
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
  });
  let res = await send();
  if (res.status >= 300) {
    await TravianService.login();
    res = await send();
  }
  if (res.status >= 300) sails.log.error('autoraid: marking ' + ids.length + ' reports unread failed (HTTP ' + res.status + ')');
}

// The newest oasis raid reports, read or not (you may have opened them in the browser), back to
// the last one kept: page after page (up to REPORT_PAGES) until a page holds only reports already
// kept. At most MAX_REPORTS_PER_ROUND are opened; the rest waits for the next round, which then
// pages past the kept ones (state.reportBacklog). A report the backfill saved is taken from its
// file instead of being opened again. Reports that were unread are marked unread again.
const REPORT_PAGES = 20;

async function readReports() {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { /* no backfill yet */ }
  const saved = new Map(history.map(r => [r.id, r]));
  const have = new Set(state.reports.concat(state.natarReports).map(r => r.id));
  let read = 0;
  let capped = false;
  const unread = [];
  try {
    for (let p = 1; p <= REPORT_PAGES && !capped; p++) {
      if (p > 1) await pause(cfg().pageGapSeconds);
      const list = await page('GET', '/report/offensive' + (p > 1 ? '?page=' + p : ''));
      const rows = [...list.matchAll(/<tr>\s*<td class="sel">[\s\S]*?<\/tr>/g)].map(m => m[0])
        .filter(r => /raids (Unoccupied oasis|Natars)/.test(plain(r)));
      let fresh = 0;
      for (const row of rows) {
        const href = (row.match(/href="\?(id=[^"]+)"/) || [])[1];
        if (!href) continue;
        const query = href.replace(/&amp;/g, '&');
        const id = decodeURIComponent(query.match(/id=([^&]+)/)[1]);
        if (have.has(id)) continue;
        fresh++;
        let report = saved.get(id);
        if (!report) {
          if (read >= MAX_REPORTS_PER_ROUND) {
            capped = true;
            break;
          }
          await pause(cfg().pageGapSeconds);
          if (/messageStatusUnread/.test(row)) unread.push(id);
          report = parseReport(await page('GET', '/report?' + query), id);
          read++;
        }
        if (!report) continue;
        (report.natars ? state.natarReports : state.reports).push(report);
        have.add(id);
        matchReport(report);
      }
      if ((!fresh && !state.reportBacklog) || !/class="next"/.test(list)) break;
    }
  } finally {
    await markUnread(unread);
  }
  state.reportBacklog = capped;
  return read;
}

// The raid this report belongs to: same oasis, village and army, the earliest without one.
function matchReport(report) {
  const same = (a, b) => Object.keys({ ...a, ...b }).every(u => (a[u] || 0) === (b[u] || 0));
  const armyOf = r => r.army || (r.unit ? { [r.unit]: r.n } : null); // first raids kept unit and n
  const raid = state.raids.find(r => !r.reportId && r.key === report.key && r.village === report.village && armyOf(r) && same(armyOf(r), report.sent));
  if (raid) raid.reportId = report.id;
}

// Every oasis raid report still in the game (read or not), page by page, one request every
// gapSeconds (random), into .tmp/report-history.json. Reports already there are not opened
// again, so it can stop and go on later. Its own file: the running app writes autoraid.json.
// Reports that were unread are marked unread again, page by page.
const HISTORY_FILE = path.join(process.cwd(), '.tmp', 'report-history.json');

async function backfillReports({ gapSeconds = [3, 6], maxPages = 200 } = {}) {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { /* first run */ }
  const have = new Set(history.map(r => r.id));
  const save = () => {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  };
  let pages = 0, added = 0;
  const unread = [];
  try {
    for (let p = 1; p <= maxPages; p++) {
      if (p > 1) await pause(gapSeconds);
      const list = await page('GET', '/report/offensive?page=' + p);
      pages++;
      const rows = [...list.matchAll(/<tr>\s*<td class="sel">[\s\S]*?<\/tr>/g)].map(m => m[0])
        .filter(r => /raids Unoccupied oasis/.test(plain(r)));
      for (const row of rows) {
        const href = (row.match(/href="\?(id=[^"]+)"/) || [])[1];
        if (!href) continue;
        const query = href.replace(/&amp;/g, '&');
        const id = decodeURIComponent(query.match(/id=([^&]+)/)[1]);
        if (have.has(id)) continue;
        await pause(gapSeconds);
        if (/messageStatusUnread/.test(row)) unread.push(id);
        const report = parseReport(await page('GET', '/report?' + query), id);
        if (!report) continue;
        history.push(report);
        have.add(id);
        added++;
        save();
      }
      await markUnread(unread.splice(0));
      sails.log.info('reports backfill: page ' + p + ', ' + added + ' new, ' + history.length + ' in all');
      if (!/class="next"/.test(list)) break;
    }
  } finally {
    await markUnread(unread);
  }
  save();
  return { pages, added, total: history.length };
}

// ---- one round ------------------------------------------------------------------------------

const SLOTS = { u61: 1, u62: 2, u64: 4, u65: 5, u66: 6 };

// Raids already on their way: from our own log and the outgoing troops of these villages.
async function onTheirWay(villages) {
  const busy = new Set(state.raids.filter(r => r.arrival && r.arrival * 1000 > Date.now()).map(r => r.key));
  for (const v of villages) {
    // 10 movements per page: every page, as long as there is a next one.
    for (let p = 1; p <= MAX_OUTGOING_PAGES; p++) {
      await pause(cfg().pageGapSeconds);
      const html = await page('GET', '/build.php?newdid=' + v.id + '&gid=16&tt=1&filter=2&subfilters=4' + (p > 1 ? '&page=' + p : ''));
      for (const key of outgoingTargets(html)) busy.add(key);
      if (!html.includes('page=' + (p + 1))) break;
    }
  }
  return busy;
}

// Free oases of the village's stages from..to, not raided now, with what the map block shows:
// [{ x, y, stage, distance, bonus, animals, resting }]. Oases found taken are remembered.
// resting: our raids hit it less than horseRestMinutes ago, so it is still filling up (no horses).
async function candidates(village, from, to, busy) {
  const scan = await OasisService.scan(village);
  const taken = OasisService.loadTaken();
  const list = scan.stages.filter(s => s.stage >= from && s.stage <= to).flatMap(s => s.oases.map(o => ({ ...o, stage: s.stage })))
    .filter(o => !taken[o.x + '|' + o.y] && !busy.has(o.x + '|' + o.y));
  if (!list.length) return [];
  await pause(cfg().pageGapSeconds);
  const tiles = await blocksFor(village, list.map(o => o.x + '|' + o.y));
  const out = [];
  const nowTaken = [];
  const hits = lastHits();
  for (const o of list) {
    const t = tiles.get(o.x + '|' + o.y);
    if (!t) continue;
    const info = OasisService.oasisOf(t);
    if (!info || !info.free) {
      if (info) nowTaken.push(info);
      continue;
    }
    const resting = Date.now() - (hits[o.x + '|' + o.y] || 0) < cfg().horseRestMinutes * MINUTE;
    out.push({ ...o, animals: OasisService.parseAnimals(t.text), resting });
  }
  if (nowTaken.length) OasisService.recordTaken(nowTaken);
  return out;
}

// When our last raid (any mode) hit each oasis: key -> arrival in ms.
function lastHits() {
  const hits = {};
  for (const r of state.raids) if (r.arrival) hits[r.key] = Math.max(hits[r.key] || 0, r.arrival * 1000);
  return hits;
}

// [{ oasis, army, plan? }] for a village in mode 'empty'. Oases hit less than restMinutes ago are
// left to fill up again, so the raids spread over the further stages.
async function planEmpty(v, home, oases, log) {
  const chosen = [];
  let left = home[v.unit] || 0;
  const hits = lastHits();
  const rested = o => Date.now() - (hits[o.x + '|' + o.y] || 0) >= (v.restMinutes || 0) * MINUTE;
  for (const o of oases.filter(o => !o.animals.length && rested(o))) {
    const n = v.perStage[o.stage];
    if (n && left >= n) {
      chosen.push({ oasis: o, army: { [v.unit]: n } });
      left -= n;
    }
  }
  if (!chosen.length) return chosen;
  // The map block may lag: check one, and all chosen if it differs.
  const pick = chosen[Math.floor(Math.random() * chosen.length)];
  await pause(cfg().pageGapSeconds);
  const tile = await OasisService.tileAnimals(pick.oasis.x, pick.oasis.y);
  log.check = { key: pick.oasis.x + '|' + pick.oasis.y, same: !tile.taken && !tile.animals.length };
  if (log.check.same) return chosen;
  const ok = [];
  for (const c of chosen) {
    await pause(cfg().pageGapSeconds);
    const t = c === pick ? tile : await OasisService.tileAnimals(c.oasis.x, c.oasis.y);
    if (t.taken) OasisService.recordTaken([c.oasis]);
    else if (!t.animals.length) ok.push(c);
  }
  return ok;
}

// [{ oasis, army, plan }] for a village in mode 'animals'. If the checked oasis differs from the
// map block, every chosen oasis is asked one by one and the plan is made again from that.
async function planAnimals(v, village, home, oases, log) {
  const planFrom = list => RaidPlanService.plan(village, list.filter(o => o.animals.length), home)
    .map(({ oasis, plan }) => ({ oasis, army: plan.army, plan }));
  let chosen = planFrom(oases);
  if (!chosen.length) return chosen;
  const pick = chosen[Math.floor(Math.random() * chosen.length)];
  await pause(cfg().pageGapSeconds);
  const tile = await OasisService.tileAnimals(pick.oasis.x, pick.oasis.y);
  log.check = { key: pick.oasis.x + '|' + pick.oasis.y, same: !tile.taken && OasisService.sameAnimals(tile.animals, pick.oasis.animals) };
  if (log.check.same) return chosen;
  const fresh = [];
  for (const c of chosen) {
    if (c !== pick) await pause(cfg().pageGapSeconds);
    const t = c === pick ? tile : await OasisService.tileAnimals(c.oasis.x, c.oasis.y);
    if (t.taken) OasisService.recordTaken([c.oasis]);
    else fresh.push({ ...c.oasis, animals: t.animals });
  }
  log.check.replanned = fresh.length;
  return planFrom(fresh);
}

// Natar villages by their reports (since the last time one was left alone, all our villages):
// NATAR_POOR.raids raids in a row under NATAR_POOR.loot each on average -> left alone for
// NATAR_POOR.days, then tried again; the last NATAR_RICH.raids all at least NATAR_RICH.fill full
// -> twice the army (up to NATAR_RICH.most times per) and twice as often. A raid back under
// half full halves the army again (not under per). 2026-10-23: of 11 Natar villages raided,
// one gave 60% of the loot and five under 50 per raid.
const NATAR_POOR = { raids: 10, loot: 50, days: 3 };
const NATAR_RICH = { raids: 3, fill: 0.9, most: 4 };

// { skip, often, size } for a Natar village raided by entry v (size: units of v.unit to send).
function natarTarget(v, village, key) {
  const since = state.natarSkip[key] || 0;
  if (since > Date.now()) return { skip: true };
  const reports = state.natarReports.filter(r => r.key === key && r.at > since)
    .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10)); // report ids grow with time; the backlog reads newest first
  const lastPoor = reports.slice(-NATAR_POOR.raids);
  if (lastPoor.length === NATAR_POOR.raids && lastPoor.reduce((t, r) => t + r.bounty, 0) / NATAR_POOR.raids < NATAR_POOR.loot) {
    state.natarSkip[key] = Date.now() + NATAR_POOR.days * 24 * 60 * MINUTE;
    sails.log.verbose('autoraid: Natar village ' + key + ' left alone for ' + NATAR_POOR.days + ' days');
    return { skip: true };
  }
  const fill = r => (r.capacity ? r.bounty / r.capacity : 0);
  const lastRich = reports.slice(-NATAR_RICH.raids);
  const rich = lastRich.length === NATAR_RICH.raids && lastRich.every(r => fill(r) >= NATAR_RICH.fill);
  const own = reports.filter(r => r.village === village.name && r.sent[v.unit]);
  const last = own[own.length - 1];
  let size = last ? last.sent[v.unit] : v.per;
  if (last && rich) size *= 2;
  else if (last && fill(last) < 0.5) size = Math.floor(size / 2);
  return { skip: (v.skip || []).includes(key), often: Math.max((v.often || {})[key] || 1, rich ? 2 : 1), size: Math.min(Math.max(size, v.per), v.per * NATAR_RICH.most) };
}

// For a target hit n times as often: the newest raid of ours on its way has done (n - 1) / n
// of its trip, so the next one hits a 1 / n trip later.
function oftenDue(key, n) {
  if (!n || n < 2) return false;
  const last = state.raids.filter(r => r.key === key && r.arrival && r.sentAt).sort((a, b) => b.arrival - a.arrival)[0];
  if (!last) return false;
  const trip = last.arrival - last.sentAt / 1000;
  return last.arrival - Date.now() / 1000 <= trip / n;
}

// [{ oasis, army }] for a village in mode 'natars': v.unit to each Natar village within
// v.radius that has no raid of ours on its way and is not left alone (v.skip or natarTarget),
// closest first, as long as at least per are at home; natarTarget's size, or what is left.
// A village in v.often ({ key: n }) hits n times as often: the next raid goes once the last
// one on its way is (n - 1) / n of its trip there. v.single: never a second raid on its way
// (no often, also not for a rich village).
// (oasis: the target, shaped as an oasis so the rest of the round treats both alike.)
async function planNatars(v, village, home, busy) {
  const chosen = [];
  let left = home[v.unit] || 0;
  for (const n of await OasisService.natars(village, v.radius)) {
    if (left < v.per) break;
    const key = n.x + '|' + n.y;
    const t = natarTarget(v, village, key);
    if (t.skip || (busy.has(key) && (v.single || !oftenDue(key, t.often)))) continue;
    const size = Math.min(t.size, left);
    chosen.push({ oasis: { ...n, stage: null, animals: [] }, army: { [v.unit]: size } });
    left -= size;
  }
  return chosen;
}

async function round() {
  const c = cfg();
  const log = { at: new Date().toISOString(), dryRun: !c.send, villages: {}, ...(state.cavStopped ? { cavStopped: true } : {}) };
  if (state.stopped) {
    log.stopped = true;
    state.lastRound = log;
    writeState();
    return log;
  }
  // 1. Troops at home (one look per village, also when it has two entries).
  const villages = [];
  const homes = {};
  for (const v of c.villages) {
    const village = await OasisService.findVillage(v.name).catch(() => null);
    if (!village) continue;
    if (!homes[v.name]) {
      await pause(c.pageGapSeconds);
      const form = await page('GET', '/build.php?newdid=' + village.id + '&gid=16&tt=2');
      homes[v.name] = Object.fromEntries(Object.entries(SLOTS).map(([u, slot]) => [u, available(form, slot)]));
    }
    // cavOnly: this entry raids with the horses alone (infantry has its own entry).
    let home = v.cavOnly ? { ...homes[v.name], u61: 0, u62: 0 } : homes[v.name];
    // /stop_cav: horses stay at home, infantry and Mercenaries go on.
    if (state.cavStopped) home = { ...home, u64: 0, u65: 0, u66: 0 };
    const enough = v.mode === 'empty' ? (home[v.unit] || 0) >= Math.min(...Object.values(v.perStage))
      : v.mode === 'natars' ? (home[v.unit] || 0) >= v.per
      : home.u61 + home.u62 >= RaidPlanService.INF_MIN || home.u64 + home.u65 + home.u66 >= RaidPlanService.CAV_MIN;
    v.label = v.name + (v.cavOnly ? ' horses' : v.mode === 'natars' ? ' natars ' + v.unit : ''); // a village may have two natars entries
    log.villages[v.label] = { mode: v.mode, home };
    villages.push({ v, village, home, enough });
  }
  // 2.-4. Plan and send, village after village.
  if (villages.some(x => x.enough)) {
    const busy = await onTheirWay(villages.map(x => x.village));
    log.onTheirWay = busy.size;
    for (const { v, village, home, enough } of villages) {
      if (!enough) continue;
      const vlog = log.villages[v.label];
      let oases = v.mode === 'natars' ? [] : await candidates(village, 1, v.stages, busy);
      if (v.mode === 'animals') {
        // Enough horses left over for the next stage's minimum: one stage more and plan again, up to maxStages.
        const cavHome = home.u64 + home.u65 + home.u66;
        vlog.stages = v.stages;
        while (vlog.stages < v.maxStages) {
          const used = RaidPlanService.plan(village, oases.filter(o => o.animals.length), home, { extra: false })
            .reduce((s, { plan }) => s + (plan.kind === 'cav' ? Object.values(plan.army).reduce((a, n) => a + n, 0) : 0), 0);
          if (cavHome - used < RaidPlanService.cavMin(vlog.stages + 1)) break;
          vlog.stages++;
          oases = oases.concat(await candidates(village, vlog.stages, vlog.stages, busy));
        }
      }
      const chosen = v.mode === 'empty' ? await planEmpty(v, home, oases, vlog)
        : v.mode === 'natars' ? await planNatars(v, village, home, busy)
        : await planAnimals(v, village, home, oases, vlog);
      vlog.targets = chosen.map(t => ({
        key: t.oasis.x + '|' + t.oasis.y, stage: t.oasis.stage, distance: t.oasis.distance, army: t.army,
        animals: t.oasis.animals.map(a => a.count + ' ' + a.unit).join(', '),
        ...(t.plan ? { pass: t.plan.pass, dead: t.plan.totalDeaths, gain: t.plan.gain, lost: Math.round(t.plan.lostRes) } : {}),
      }));
      vlog.sent = [];
      for (const t of chosen) busy.add(t.oasis.x + '|' + t.oasis.y); // later entries go on with the next oases
      for (const t of chosen) {
        const key = t.oasis.x + '|' + t.oasis.y;
        if (!c.send) continue;
        await pause(c.sendGapSeconds);
        try {
          const arrival = await sendRaid(village, key, t.army, v.mode === 'natars' ? 'Natars' : 'Nature');
          busy.add(key);
          for (const [u, n] of Object.entries(t.army)) {
            homes[v.name][u] -= n;
            if (home !== homes[v.name]) home[u] -= n;
          }
          state.raids.push({
            key, village: village.name, mode: v.mode, stage: t.oasis.stage, army: t.army, sentAt: Date.now(), arrival,
            animals: Object.fromEntries(t.oasis.animals.map(a => [a.unit, a.count])),
            predicted: t.plan ? { deaths: t.plan.deaths, lostRes: Math.round(t.plan.lostRes), gain: t.plan.gain } : null,
          });
          vlog.sent.push(key);
        } catch (e) {
          vlog.error = key + ': ' + e.message;
          sails.log.error('autoraid: ' + village.name + ' send to ' + key + ' failed: ' + e.message);
          break;
        }
      }
      writeState();
    }
  }
  // 5. Reports.
  try {
    if (c.send) log.reportsRead = await readReports();
  } catch (e) {
    log.reportsError = e.message;
  }
  state.lastRound = log;
  writeState();
  sails.log.verbose('autoraid: ' + (c.send ? '' : 'DRY RUN ') + Object.entries(log.villages).map(([name, v]) =>
    name + ' ' + (v.targets ? (c.send ? 'sent ' + v.sent.length : 'would send ' + v.targets.length) : 'too few at home')).join(', ')
    + ', reports read ' + (log.reportsRead || 0));
  return log;
}

async function loop() {
  for (;;) {
    try {
      await OasisService.serial(round);
    } catch (e) {
      sails.log.error('autoraid: round failed: ' + e.message);
      state.lastRound = { at: new Date().toISOString(), error: e.message };
      writeState();
    }
    await new Promise(r => setTimeout(r, rand([cfg().minMinutes, cfg().maxMinutes]) * MINUTE));
  }
}

// How the raids with a report turned out, per mode: predicted against real losses, kill bonus,
// loot.
function evaluation() {
  const byMode = {};
  for (const raid of state.raids) {
    const report = raid.reportId && state.reports.find(r => r.id === raid.reportId);
    if (!report) continue;
    const m = byMode[raid.mode || 'empty'] = byMode[raid.mode || 'empty'] || {
      raids: 0, predictedDead: 0, dead: 0, lostRes: 0, heroBonus: 0, loot: 0, foundMoreAnimals: 0,
    };
    const units = r => Object.values(r || {}).reduce((s, n) => s + n, 0);
    m.raids++;
    m.predictedDead += units(raid.predicted && raid.predicted.deaths);
    m.dead += units(report.dead);
    m.lostRes += Object.entries(report.dead).reduce((s, [u, n]) => s + n * RaidPlanService.B.UNITS[u].cost, 0);
    m.heroBonus += report.heroBonus;
    m.loot += report.bounty;
    if (units(report.found) > units(raid.animals)) m.foundMoreAnimals++;
  }
  return byMode;
}

module.exports = {
  start: function () {
    if (!cfg().enabled) return;
    readState();
    sails.log.verbose('autoraid: on for ' + cfg().villages.map(v => v.name + ' (' + v.mode + ')').join(', ')
      + (cfg().send ? '' : ' (DRY RUN, nothing is sent)') + (state.stopped ? ', STOPPED until /start' : ''));
    loop();
  },

  // One round now (npm run autoraid): same as the loop does.
  round: function () {
    readState();
    return OasisService.serial(round);
  },

  // /stop and /start: no sends until started again (rounds then only note that they are stopped).
  // /start also ends /stop_cav.
  stop: function () {
    state.stopped = true;
    writeState();
    sails.log.verbose('autoraid: stopped');
  },
  resume: function () {
    state.stopped = false;
    state.cavStopped = false;
    writeState();
    sails.log.verbose('autoraid: started');
  },
  // /stop_cav and /start_cav: only the horses stay at home.
  stopCav: function () {
    state.cavStopped = true;
    writeState();
    sails.log.verbose('autoraid: horses stopped');
  },
  resumeCav: function () {
    state.cavStopped = false;
    writeState();
    sails.log.verbose('autoraid: horses started');
  },

  status: function () {
    return {
      enabled: cfg().enabled,
      send: cfg().send,
      stopped: state.stopped,
      cavStopped: state.cavStopped,
      villages: cfg().villages,
      lastRound: state.lastRound,
      raidsSent: state.raids.length,
      onTheirWay: state.raids.filter(r => r.arrival && r.arrival * 1000 > Date.now()).length,
      reportsRead: state.reports.length,
      evaluation: evaluation(),
      lastReports: state.reports.slice(-10),
    };
  },

  backfillReports,
  sendRaid,
  parseReport,
  outgoingTargets,
  available,
  confirmForm,
};
