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
 *       reports a poor village is left alone for a while, a slow one is hit once its bag has
 *       filled up, and one whose last raid came back full gets twice the army at once
 *       (natarTarget);
 *     - mode 'players': no oases; each of v.targets (player villages) gets n of v.unit every
 *       v.everyMinutes, not waiting for the last raid to come back (planPlayers). The units
 *       these raids keep busy are held back from the later entries of that village (playerHold);
 *       a target whose raid lost more than v.maxLoss of the army, found troops there and brought
 *       back less than 100, whose owner grew since our first raid (village watch), or that changed
 *       owner, is left alone until /start;
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

const EMPTY_STATE = { raids: [], reports: [], natarReports: [], natarSkip: {}, playerReports: [], playerStops: {}, lastRound: null, stopped: false, cavStopped: false, villageStops: {} };
let state = { ...EMPTY_STATE };

function readState() {
  try { state = { ...EMPTY_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (e) { /* first run */ }
}

function writeState() {
  state.raids = state.raids.slice(-KEEP);
  state.reports = state.reports.slice(-KEEP);
  state.natarReports = state.natarReports.slice(-KEEP);
  state.playerReports = state.playerReports.slice(-KEEP);
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

// Report of a raid on a player village (target t of a 'players' entry, found by its village name
// in the title), or null.
function parsePlayerReport(html, id, t) {
  const start = html.indexOf('id="reportWrapper"');
  const body = html.slice(start, start + 60000);
  const text = plain(body);
  const title = text.match(/(\S+) raids (.+?) \d\d\.\d\d\.\d\d, \d\d:\d\d:\d\d/);
  if (!title || !title[2].includes(t.village)) return null;
  const own = Array.from({ length: 10 }, (_, i) => 'u' + (61 + i));
  const att = unitRows(body, 'u61');
  const bounty = text.match(/Bounty ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+)\s*\/\s*([\d,]+)/);
  const num = s => Number(String(s).replace(/,/g, ''));
  // Defender troops: the first units row of the defender side (any tribe, its own unit header).
  const defSide = body.slice(Math.max(0, body.indexOf('class="role defender"')));
  const defFirst = (defSide.match(/class="unit (u\d+)"/) || [])[1];
  const defenders = defFirst && body.includes('class="role defender"') ? (unitRows(defSide, defFirst)[0] || []).slice(0, 10).reduce((s, n) => s + n, 0) : 0;
  return {
    id, player: true, village: title[1], key: t.key, owner: t.owner,
    time: (text.match(/(\d\d\.\d\d\.\d\d, \d\d:\d\d:\d\d)/) || [])[1] || null,
    sent: toCounts(own, att[0]),
    dead: toCounts(own, att[1]),
    bounty: bounty ? [1, 2, 3, 4].reduce((s, i) => s + num(bounty[i]), 0) : 0,
    carried: bounty ? num(bounty[5]) : null,
    capacity: bounty ? num(bounty[6]) : null,
    defenders,
    at: Date.now(),
  };
}

// The 'players' entries' targets: [{ key, n, owner, village, entry }].
const playerTargets = () => cfg().villages.filter(v => v.mode === 'players').flatMap(v => v.targets.map(t => ({ ...t, entry: v })));

// Leaves player target t alone until /start.
function stopPlayer(t, reason) {
  if (state.playerStops[t.key]) return;
  state.playerStops[t.key] = { at: new Date().toISOString(), reason };
  sails.log.error('autoraid: player raids on ' + t.key + ' (' + t.owner + ') stopped: ' + reason);
}

// A player raid that lost more than its entry's maxLoss (share) or maxLossUnits (troops), or found troops there and brought back
// less than PLAYER_MIN_LOOT: that target is left alone until /start.
const PLAYER_MIN_LOOT = 100;
function checkPlayerReport(report, t) {
  const units = r => Object.values(r || {}).reduce((s, n) => s + n, 0);
  const sent = units(report.sent);
  if (!sent) return;
  if (units(report.dead) > (t.entry.maxLoss || 0) * sent || units(report.dead) > (t.entry.maxLossUnits || Infinity)) stopPlayer(t, 'lost ' + units(report.dead) + ' of ' + sent + ' (report ' + report.id + ')');
  else if (report.defenders > 0 && report.bounty < PLAYER_MIN_LOOT) stopPlayer(t, report.defenders + ' troops there, loot ' + report.bounty + ' (report ' + report.id + ')');
}

// A player target whose owner grew (village watch, any of their villages) since our first raid
// on it, or since the last /start: the player is active, so that target is left alone until /start.
function checkPlayersActive() {
  let villages;
  try { villages = VillageWatchService.activity().villages; } catch (e) { return; }
  for (const t of playerTargets()) {
    const w = villages[t.key];
    if (state.playerStops[t.key] || !w || w[2] == null) continue;
    const grewAt = Date.now() - w[2] * 3600 * 1000;
    const first = state.raids.filter(r => r.mode === 'players' && r.key === t.key).reduce((m, r) => Math.min(m, r.sentAt || Infinity), Infinity);
    if (grewAt > Math.max(first, state.resumedAt || 0)) stopPlayer(t, 'player active, grew ' + w[2] + ' h ago');
  }
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
  const have = new Set(state.reports.concat(state.natarReports, state.playerReports).map(r => r.id));
  const targets = playerTargets();
  // A player target the row's title names (village name after "raids").
  const targetOf = row => targets.find(t => plain(row).includes(' raids ' + t.village));
  let read = 0;
  let capped = false;
  const unread = [];
  try {
    for (let p = 1; p <= REPORT_PAGES && !capped; p++) {
      if (p > 1) await pause(cfg().pageGapSeconds);
      const list = await page('GET', '/report/offensive' + (p > 1 ? '?page=' + p : ''));
      const rows = [...list.matchAll(/<tr>\s*<td class="sel">[\s\S]*?<\/tr>/g)].map(m => m[0])
        .filter(r => /raids (Unoccupied oasis|Natars)/.test(plain(r)) || targetOf(r));
      let fresh = 0;
      for (const row of rows) {
        const href = (row.match(/href="\?(id=[^"]+)"/) || [])[1];
        if (!href) continue;
        const query = href.replace(/&amp;/g, '&');
        const id = decodeURIComponent(query.match(/id=([^&]+)/)[1]);
        if (have.has(id)) continue;
        fresh++;
        const target = targetOf(row);
        let report = target ? null : saved.get(id);
        if (!report) {
          if (read >= MAX_REPORTS_PER_ROUND) {
            capped = true;
            break;
          }
          await pause(cfg().pageGapSeconds);
          if (/messageStatusUnread/.test(row)) unread.push(id);
          const html = await page('GET', '/report?' + query);
          report = target ? parsePlayerReport(html, id, target) : parseReport(html, id);
          read++;
        }
        if (!report) continue;
        if (report.player) {
          state.playerReports.push(report);
          have.add(id);
          checkPlayerReport(report, target);
          continue;
        }
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
// cleared: someone else cleared it before our raid came (clearedOases), planned last.
// scanFrom: the village whose oasis stages are used (v.oasesOf; the village itself when not set).
async function candidates(village, from, to, busy, scanFrom = village) {
  const scan = await OasisService.scan(scanFrom);
  const taken = OasisService.loadTaken();
  const list = scan.stages.filter(s => s.stage >= from && s.stage <= to).flatMap(s => s.oases.map(o => ({ ...o, stage: s.stage })))
    .filter(o => !taken[o.x + '|' + o.y] && !busy.has(o.x + '|' + o.y));
  if (!list.length) return [];
  await pause(cfg().pageGapSeconds);
  const tiles = await blocksFor(village, list.map(o => o.x + '|' + o.y));
  const out = [];
  const nowTaken = [];
  const hits = lastHits();
  const cleared = clearedOases();
  for (const o of list) {
    const t = tiles.get(o.x + '|' + o.y);
    if (!t) continue;
    const info = OasisService.oasisOf(t);
    if (!info || !info.free) {
      if (info) nowTaken.push(info);
      continue;
    }
    const resting = Date.now() - (hits[o.x + '|' + o.y] || 0) < cfg().horseRestMinutes * MINUTE;
    out.push({ ...o, animals: OasisService.parseAnimals(t.text), resting, cleared: cleared.has(o.x + '|' + o.y) });
  }
  if (nowTaken.length) OasisService.recordTaken(nowTaken);
  return out;
}

// Oases where one of our animal raids arriving in the last CLEARED_HOURS found no animals,
// though there were some when it went: someone else farms them. 2026-10-26: 62 of 509 animal
// raids came to a cleared oasis (17 of them 200 Mercenaries on 3 h trips); within 12 h after one,
// 8 of 19 raids there did too.
const CLEARED_HOURS = 12;
function clearedOases() {
  const since = Date.now() - CLEARED_HOURS * 60 * MINUTE;
  const reports = new Map(state.reports.map(r => [r.id, r]));
  const out = new Set();
  for (const r of state.raids) {
    const rep = r.mode === 'animals' && r.arrival * 1000 > since && reports.get(r.reportId);
    if (rep && Object.keys(r.animals || {}).length && !Object.keys(rep.found || {}).length) out.add(r.key);
  }
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
  // Oases with animals that got no raid, by why horses would not go (log.skipped, e.g. ratio: 40).
  const skipped = chosen => {
    const raided = new Set(chosen.map(c => c.oasis.x + '|' + c.oasis.y));
    log.skipped = {};
    log.horsesLeft = ['u64', 'u65', 'u66'].reduce((s, u) => s + (home[u] || 0), 0)
      - chosen.reduce((s, c) => s + ['u64', 'u65', 'u66'].reduce((a, u) => a + (c.army[u] || 0), 0), 0);
    for (const o of oases) {
      if (!o.animals.length || raided.has(o.x + '|' + o.y)) continue;
      const why = RaidPlanService.cavSkip(o);
      log.skipped[why] = (log.skipped[why] || 0) + 1;
    }
  };
  skipped(chosen);
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
  chosen = planFrom(fresh);
  skipped(chosen);
  return chosen;
}

// Natar villages by their reports (since the last time one was left alone, all our villages):
// NATAR_POOR.raids raids in a row under NATAR_POOR.loot each on average -> left alone for
// NATAR_POOR.days, then tried again with NATAR_RICH.most times per (3 days' stock). The last
// report at least NATAR_RICH.fill full -> the next raid goes now (also with one on its way) with
// twice the army (up to NATAR_RICH.most times per); a raid back under half full halves it again
// (not under per). A village making under NATAR_SLOW.rate an hour is hit only once a bag of the
// army has filled up there (at most NATAR_SLOW.hours). 2026-10-25: full raids were always the
// first hit after a pause (-103|52 750, 1050, 948, then 42); 62% of the Natar raids went to
// villages giving under 100 a raid; -86|48 alone 680 an hour.
const NATAR_POOR = { raids: 10, loot: 50, days: 3 };
const NATAR_RICH = { fill: 0.9, most: 4 };
const NATAR_SLOW = { rate: 100, hours: 24, reports: 10 };

// Report time "25.10.26, 07:09:01" (server time) -> ms, to compare reports with each other.
function reportTime(r) {
  const m = (r.time || '').match(/(\d\d)\.(\d\d)\.(\d\d), (\d\d):(\d\d):(\d\d)/);
  return m ? Date.UTC(2000 + Number(m[3]), m[2] - 1, m[1], m[4], m[5], m[6]) : null;
}

// Resources an hour the village gave over its last NATAR_SLOW.reports reports, or null.
function natarRate(reports) {
  const last = reports.slice(-NATAR_SLOW.reports);
  if (last.length < 3) return null;
  const hours = (reportTime(last[last.length - 1]) - reportTime(last[0])) / (60 * MINUTE);
  return hours > 0 ? last.slice(1).reduce((t, r) => t + r.bounty, 0) / hours : null;
}

// { skip, often, size, now, wait } for a Natar village raided by entry v (size: units of v.unit
// to send; now: send even with a raid on its way; wait: hours between hits, for a slow one).
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
  const latest = reports[reports.length - 1];
  const full = !!latest && fill(latest) >= NATAR_RICH.fill;
  // Followed up already: a raid of ours left after the full report was read.
  const now = full && !state.raids.some(r => r.key === key && r.sentAt > latest.at);
  const own = reports.filter(r => r.village === village.name && r.sent[v.unit]);
  const last = own[own.length - 1];
  let size = last ? last.sent[v.unit] : v.per;
  if (since && !reports.length) size = v.per * NATAR_RICH.most; // back after being left alone
  else if (full) size = Math.max(size, v.per) * 2;
  else if (last && fill(last) < 0.5) size = Math.floor(size / 2);
  size = Math.min(Math.max(size, v.per), v.per * NATAR_RICH.most);
  const rate = natarRate(reports);
  const carry = size * RaidPlanService.B.UNITS[v.unit].carry;
  const wait = !full && rate !== null && rate < NATAR_SLOW.rate ? Math.min(NATAR_SLOW.hours, carry / Math.max(rate, 1)) : 0;
  return { skip: (v.skip || []).includes(key), often: (v.often || {})[key] || 1, size, now, wait };
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

// A slow Natar village: the new raid (trip hours there) lands at least wait hours after our
// last raid hit it.
function slowDue(key, wait, trip) {
  const hit = lastHits()[key];
  return !hit || Date.now() + trip * 60 * MINUTE >= hit + wait * 60 * MINUTE;
}

// [{ oasis, army }] for a village in mode 'natars': v.unit to each Natar village within
// v.radius that has no raid of ours on its way (unless its last report came back full) and is
// not left alone (v.skip or natarTarget), a slow one only once its bag has filled up, closest
// first, as long as at least per are at home; natarTarget's size, or what is left.
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
    if (t.skip || (busy.has(key) && (v.single || !(t.now || oftenDue(key, t.often))))) continue;
    if (t.wait && !slowDue(key, t.wait, n.distance / RaidPlanService.B.UNITS[v.unit].speed)) continue;
    const size = Math.min(t.size, left);
    chosen.push({ oasis: { ...n, stage: null, animals: [] }, army: { [v.unit]: size } });
    left -= size;
  }
  return chosen;
}

const wrap = v => ((((v + 200) % 401) + 401) % 401) - 200; // map edge to edge

// Player raids of village `name` to `key` (all of them, sent by the 'players' entries).
const playerRaids = (name, key) => state.raids.filter(r => r.mode === 'players' && r.village === name && r.key === key);

// Hours one way from village to target t with v.unit: the last raid's real trip (tournament
// square and all), else distance / speed.
function playerTrip(v, village, t) {
  const last = playerRaids(village.name, t.key).filter(r => r.arrival && r.sentAt).pop();
  if (last) return (last.arrival * 1000 - last.sentAt) / (60 * MINUTE);
  const [x, y] = t.key.split('|').map(Number);
  return Math.hypot(wrap(x - village.x), wrap(y - village.y)) / RaidPlanService.B.UNITS[v.unit].speed;
}

// Units of v.unit for the next raid on player target t: PLAYER_SIZE.margin times the biggest loot
// of the last PLAYER_SIZE.reports reports, in bags, at least PLAYER_SIZE.min, at most t.n. A bag
// that came back at least PLAYER_SIZE.full full doubles the last army (up to t.n); no report yet:
// PLAYER_SIZE.first (a test raid). 2026-10-26: raids came back 32% full, the loot each hour the
// village's production (kurdesz 200 Marksmen for ~7k, 100 carry 10.5k).
const PLAYER_SIZE = { margin: 1.3, reports: 3, min: 30, full: 0.9, first: 50 };
function playerArmy(v, t) {
  const n = Math.min(t.n, PLAYER_SIZE.first);
  const last = state.playerReports.filter(r => r.key === t.key && r.capacity).slice(-PLAYER_SIZE.reports);
  if (!last.length) return n;
  const sent = r => r.sent[v.unit] || 0;
  const top = last[last.length - 1];
  if (top.bounty >= PLAYER_SIZE.full * top.capacity) return Math.min(t.n, Math.max(PLAYER_SIZE.min, 2 * sent(top)));
  const loot = Math.max(...last.map(r => r.bounty));
  const carry = RaidPlanService.B.UNITS[v.unit].carry;
  return Math.min(t.n, Math.max(PLAYER_SIZE.min, Math.ceil(PLAYER_SIZE.margin * loot / carry)));
}

// Units of v.unit to keep at home for the player raids: per target, one army (playerArmy) for every raid that is
// out at once (a send every everyMinutes over a round trip), less the ones out on those raids now.
function playerHold(v, village) {
  let hold = 0;
  for (const t of v.targets) {
    if (state.playerStops[t.key]) continue;
    const roundTrip = 2 * playerTrip(v, village, t) * 60;
    const need = playerArmy(v, t) * Math.ceil(roundTrip / v.everyMinutes);
    const out = playerRaids(village.name, t.key)
      .filter(r => r.arrival && 2 * r.arrival * 1000 - r.sentAt > Date.now())
      .reduce((s, r) => s + (r.army[v.unit] || 0), 0);
    hold += Math.max(0, need - out);
  }
  return hold;
}

// [{ oasis, army, owner }] for a village in mode 'players': playerArmy of v.unit to each target whose
// last raid from here went at least everyMinutes ago, as long as that many are at home.
function planPlayers(v, village, home) {
  const chosen = [];
  let left = home[v.unit] || 0;
  for (const t of v.targets) {
    const n = playerArmy(v, t);
    if (state.playerStops[t.key] || left < n) continue;
    const last = playerRaids(village.name, t.key).reduce((m, r) => Math.max(m, r.sentAt || 0), 0);
    if (Date.now() - last < v.everyMinutes * MINUTE) continue;
    const [x, y] = t.key.split('|').map(Number);
    chosen.push({ oasis: { x, y, stage: null, animals: [] }, army: { [v.unit]: n }, owner: t.owner });
    left -= n;
  }
  return chosen;
}

// What entry v may use of the troops at home: cavOnly raids with the horses alone (infantry has
// its own entry); /stop_cav keeps all horses at home; /stop2cav, /stop2inf (/stop2 = both) that
// village's horses or infantry on oases and Natars (its player raids go on: the user stopped
// mansim2's horses on 2026-10-26 to farm players with them). Made again from the live counts before each entry plans, so it
// sees what the entries before sent.
function homeOf(v, troops) {
  const vs = (state.villageStops || {})[v.name] || {};
  const home = { ...troops };
  if (v.cavOnly || vs.inf) Object.assign(home, { u61: 0, u62: 0 });
  if (state.cavStopped || (vs.cav && v.mode !== 'players')) Object.assign(home, { u64: 0, u65: 0, u66: 0 });
  return home;
}

async function round() {
  const c = cfg();
  const log = { at: new Date().toISOString(), dryRun: !c.send, villages: {}, ...(state.cavStopped ? { cavStopped: true } : {}),
    ...(Object.keys(state.villageStops || {}).length ? { villageStops: state.villageStops } : {}) };
  if (state.stopped) {
    log.stopped = true;
    state.lastRound = log;
    writeState();
    return log;
  }
  // 1. Troops at home (one look per village, also when it has two entries).
  const villages = [];
  const homes = {};
  checkPlayersActive();
  const holds = {}; // village name -> { unit: n } held back for the player raids
  for (const v of c.villages) {
    const village = await OasisService.findVillage(v.name).catch(() => null);
    if (!village) continue;
    if (!homes[v.name]) {
      await pause(c.pageGapSeconds);
      const form = await page('GET', '/build.php?newdid=' + village.id + '&gid=16&tt=2');
      homes[v.name] = Object.fromEntries(Object.entries(SLOTS).map(([u, slot]) => [u, available(form, slot)]));
    }
    const home = homeOf(v, homes[v.name]);
    const enough = v.mode === 'empty' ? (home[v.unit] || 0) >= Math.min(...Object.values(v.perStage))
      : v.mode === 'natars' ? (home[v.unit] || 0) >= v.per
      : v.mode === 'players' ? (home[v.unit] || 0) >= Math.min(...v.targets.map(t => playerArmy(v, t)))
      : home.u61 + home.u62 >= RaidPlanService.INF_MIN || home.u64 + home.u65 + home.u66 >= RaidPlanService.CAV_MIN;
    v.label = v.name + (v.cavOnly ? ' horses' + (v.oasesOf ? ' on ' + v.oasesOf : '') : v.mode === 'natars' ? ' natars ' + v.unit : v.mode === 'players' ? ' players' : ''); // a village may have two natars entries
    log.villages[v.label] = { mode: v.mode, home };
    // oasesOf: raids the oases of another village's stages (mansim3's Marksmen farm mansim2's).
    const scanFrom = v.oasesOf ? await OasisService.findVillage(v.oasesOf).catch(() => null) : village;
    if (!scanFrom) continue;
    villages.push({ v, village, enough, scanFrom });
    // Units the player raids need are held back from this village's later entries.
    if (v.mode === 'players') {
      holds[v.name] = { ...holds[v.name], [v.unit]: ((holds[v.name] || {})[v.unit] || 0) + playerHold(v, village) };
      log.villages[v.label].hold = holds[v.name][v.unit];
    }
  }
  // 2.-4. Plan and send, village after village.
  if (villages.some(x => x.enough)) {
    const busy = await onTheirWay(villages.map(x => x.village));
    log.onTheirWay = busy.size;
    for (const { v, village, enough, scanFrom } of villages) {
      if (!enough) continue;
      const vlog = log.villages[v.label];
      const home = homeOf(v, homes[v.name]);
      // What this entry may send: home less what the player raids hold back.
      const hold = v.mode === 'players' ? null : holds[v.name];
      const free = hold ? Object.fromEntries(Object.entries(home).map(([u, n]) => [u, Math.max(0, n - (hold[u] || 0))])) : home;
      if (hold) vlog.free = free;
      let oases = v.mode === 'natars' || v.mode === 'players' ? [] : await candidates(village, 1, v.stages, busy, scanFrom);
      if (v.mode === 'animals') {
        // Enough horses left over for the next stage's minimum: one stage more and plan again, up to maxStages.
        const cavHome = free.u64 + free.u65 + free.u66;
        vlog.stages = v.stages;
        while (vlog.stages < v.maxStages) {
          const used = RaidPlanService.plan(village, oases.filter(o => o.animals.length), free, { extra: false })
            .reduce((s, { plan }) => s + (plan.kind === 'cav' ? Object.values(plan.army).reduce((a, n) => a + n, 0) : 0), 0);
          if (cavHome - used < RaidPlanService.cavMin(vlog.stages + 1)) break;
          vlog.stages++;
          oases = oases.concat(await candidates(village, vlog.stages, vlog.stages, busy, scanFrom));
        }
      }
      const chosen = v.mode === 'empty' ? await planEmpty(v, free, oases, vlog)
        : v.mode === 'natars' ? await planNatars(v, village, free, busy)
        : v.mode === 'players' ? planPlayers(v, village, home)
        : await planAnimals(v, village, free, oases, vlog);
      vlog.targets = chosen.map(t => ({
        key: t.oasis.x + '|' + t.oasis.y, stage: t.oasis.stage, distance: t.oasis.distance, army: t.army,
        animals: t.oasis.animals.map(a => a.count + ' ' + a.unit).join(', '),
        ...(t.plan ? { pass: t.plan.pass, dead: t.plan.totalDeaths, gain: t.plan.gain, lost: Math.round(t.plan.lostRes) } : {}),
      }));
      vlog.sent = [];
      if (v.mode !== 'players') for (const t of chosen) busy.add(t.oasis.x + '|' + t.oasis.y); // later entries go on with the next oases
      for (const t of chosen) {
        const key = t.oasis.x + '|' + t.oasis.y;
        if (!c.send) continue;
        await pause(c.sendGapSeconds);
        try {
          const arrival = await sendRaid(village, key, t.army, t.owner || (v.mode === 'natars' ? 'Natars' : 'Nature'));
          if (v.mode !== 'players') busy.add(key);
          for (const [u, n] of Object.entries(t.army)) {
            homes[v.name][u] -= n;
            if (v.mode === 'players') holds[v.name][u] = Math.max(0, holds[v.name][u] - n); // out now, not at home
          }
          state.raids.push({
            key, village: village.name, mode: v.mode, stage: t.oasis.stage, army: t.army, sentAt: Date.now(), arrival,
            animals: Object.fromEntries(t.oasis.animals.map(a => [a.unit, a.count])),
            predicted: t.plan ? { deaths: t.plan.deaths, lostRes: Math.round(t.plan.lostRes), gain: t.plan.gain } : null,
          });
          vlog.sent.push(key);
        } catch (e) {
          vlog.error = key + ': ' + e.message;
          if (v.mode === 'players' && /target is not/.test(e.message)) {
            state.playerStops[key] = { at: new Date().toISOString(), reason: e.message };
            sails.log.error('autoraid: player raids on ' + key + ' stopped: ' + e.message);
            continue;
          }
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

// Per player target: raids sent, reports, loot and losses of the last 24 h, stopped or not.
function playerStatus() {
  const since = Date.now() - 24 * 60 * MINUTE;
  const units = r => Object.values(r || {}).reduce((s, n) => s + n, 0);
  return Object.fromEntries(playerTargets().map(t => {
    const reports = state.playerReports.filter(r => r.key === t.key && r.at > since);
    return [t.key, {
      owner: t.owner, n: t.n, next: playerArmy(t.entry, t),
      sent24h: state.raids.filter(r => r.mode === 'players' && r.key === t.key && r.sentAt > since).length,
      reports24h: reports.length,
      loot24h: reports.reduce((s, r) => s + r.bounty, 0),
      dead24h: reports.reduce((s, r) => s + units(r.dead), 0),
      ...(state.playerStops[t.key] ? { stopped: state.playerStops[t.key] } : {}),
    }];
  }));
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
  // /start also ends /stop_cav, every /stopN and the player targets left alone after losses.
  stop: function () {
    state.stopped = true;
    writeState();
    sails.log.verbose('autoraid: stopped');
  },
  resume: function () {
    state.stopped = false;
    state.cavStopped = false;
    state.villageStops = {};
    state.playerStops = {};
    state.resumedAt = Date.now(); // growth before this no longer stops a player target
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
  // /stopN[cav|inf] and /startN[cav|inf]: one village (mansimN) only; kinds is ['cav', 'inf'] or one of them.
  stopVillage: function (name, kinds, stop) {
    state.villageStops = state.villageStops || {};
    const vs = state.villageStops[name] = state.villageStops[name] || {};
    for (const k of kinds) if (stop) vs[k] = true; else delete vs[k];
    if (!vs.cav && !vs.inf) delete state.villageStops[name];
    writeState();
    sails.log.verbose('autoraid: ' + name + ' ' + kinds.join('+') + (stop ? ' stopped' : ' started'));
    return state.villageStops[name] || {};
  },

  status: function () {
    return {
      enabled: cfg().enabled,
      send: cfg().send,
      stopped: state.stopped,
      cavStopped: state.cavStopped,
      villageStops: state.villageStops,
      villages: cfg().villages,
      lastRound: state.lastRound,
      raidsSent: state.raids.length,
      onTheirWay: state.raids.filter(r => r.arrival && r.arrival * 1000 > Date.now()).length,
      reportsRead: state.reports.length,
      evaluation: evaluation(),
      lastReports: state.reports.slice(-10),
      players: playerStatus(),
    };
  },

  backfillReports,
  sendRaid,
  parseReport,
  outgoingTargets,
  available,
  confirmForm,
};
