/**
 * AutoRaidService
 *
 * Raids empty oases from one village (sails.config.travian.autoRaid), round after round, every
 * minMinutes..maxMinutes at random. One round:
 *  1. outgoing troops of the watched villages: an oasis with a raid on its way gets no other;
 *  2. Mercenaries at home in the raiding village (rally point send form);
 *  3. the oases of the first stages (OasisService scan of that village): never-owned, from map
 *     blocks; one empty one is checked against tile-details, all chosen ones if that differs;
 *  4. one raid per empty oasis, closest first: perStage[stage] Mercenaries, as long as that
 *     many are at home (the rest stays home);
 *  5. unread oasis raid reports are opened and their results kept for /autoraid.
 * With send off (dry run) step 4 only logs what it would send, and step 5 is left out.
 * Kept in .tmp/autoraid.json: raids sent, reports read, the last round.
 */
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(process.cwd(), '.tmp', 'autoraid.json');
const KEEP = 2000; // raids and reports kept
const MAX_BLOCKS = 8;
const MAX_REPORTS_PER_ROUND = 15;
const MINUTE = 60 * 1000;

let state = { raids: [], reports: [], lastRound: null };
let running = false;

function readState() {
  try { state = { raids: [], reports: [], lastRound: null, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (e) { /* first run */ }
}

function writeState() {
  state.raids = state.raids.slice(-KEEP);
  state.reports = state.reports.slice(-KEEP);
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

// Confirmation page -> { body, arrival } for the final post, or throws.
function confirmForm(html, n, slot) {
  const at = html.indexOf('id="troopSendForm"');
  if (at < 0) {
    const err = html.match(/class="error[^"]*"[^>]*>([\s\S]*?)<\//);
    throw new Error('no confirmation page' + (err ? ': ' + plain(err[1]).trim() : ''));
  }
  const form = html.slice(html.lastIndexOf('<form', at), html.indexOf('</form>', at));
  if (!/Nature/.test(plain(form))) throw new Error('target is not nature any more');
  const fields = [...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1], m[2]]);
  const sent = fields.find(([k]) => k === 'troops[0][t' + slot + ']');
  if (!sent || Number(sent[1]) !== n) throw new Error('confirmation shows ' + (sent ? sent[1] : 'no') + ' troops instead of ' + n);
  const checksum = (html.match(/input\[name=checksum\]'\)\.value = '([^']+)'/) || [])[1];
  if (!checksum) throw new Error('no checksum on the confirmation page');
  const body = new URLSearchParams(fields.map(([k, v]) => [k, k === 'checksum' ? checksum : v.replace(/&amp;/g, '&')])).toString();
  const arrival = Number((html.match(/id="at"[^>]*value="(\d+)"/) || [])[1]) || null;
  return { body, arrival };
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function sendRaid(village, key, n, slot) {
  const [x, y] = key.split('|');
  await page('GET', '/build.php?newdid=' + village.id + '&gid=16&tt=2&eventType=4&x=' + x + '&y=' + y);
  await pause(cfg().pageGapSeconds);
  const p = new URLSearchParams();
  for (let i = 1; i <= 11; i++) p.set('troop[t' + i + ']', i === slot ? String(n) : '');
  p.set('villagename', ''); p.set('x', x); p.set('y', y); p.set('eventType', '4'); p.set('ok', 'ok');
  const confirm = await page('POST', '/build.php?gid=16&tt=2', { body: p.toString(), headers: FORM });
  const { body, arrival } = confirmForm(confirm, n, slot);
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
  const title = text.match(/(\S+) raids Unoccupied oasis \(\s*(-?\d+)\s*\|\s*(-?\d+)\s*\)/);
  if (!title) return null;
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
  };
}

// Opens the unread oasis raid reports (which marks them read) and keeps their results.
async function readReports() {
  const list = await page('GET', '/report/offensive');
  const rows = [...list.matchAll(/<tr>\s*<td class="sel">[\s\S]*?<\/tr>/g)].map(m => m[0])
    .filter(r => r.includes('messageStatusUnread') && /raids Unoccupied oasis/.test(plain(r)));
  let read = 0;
  for (const row of rows.slice(0, MAX_REPORTS_PER_ROUND)) {
    const href = (row.match(/href="\?(id=[^"]+)"/) || [])[1];
    if (!href) continue;
    const id = decodeURIComponent(href.replace(/&amp;/g, '&').match(/id=([^&]+)/)[1]);
    if (state.reports.some(r => r.id === id)) continue;
    await pause(cfg().pageGapSeconds);
    const report = parseReport(await page('GET', '/report?' + href.replace(/&amp;/g, '&')), id);
    if (report) {
      state.reports.push(report);
      read++;
    }
  }
  return read;
}

// ---- one round ------------------------------------------------------------------------------

async function round() {
  const c = cfg();
  const slot = Number(c.unit.slice(1)) % 10 || 10;
  const village = await OasisService.findVillage(c.village);
  const scan = await OasisService.scan(village);
  const stages = scan.stages.filter(s => c.perStage[s.stage]);
  const log = { at: new Date().toISOString(), dryRun: !c.send, village: village.name };

  // 1. Raids already on their way, from the watched villages and from our own log.
  const busy = new Set(state.raids.filter(r => r.arrival && r.arrival * 1000 > Date.now()).map(r => r.key));
  for (const name of c.watchVillages) {
    const v = await OasisService.findVillage(name).catch(() => null);
    if (!v) continue;
    await pause(c.pageGapSeconds);
    for (const key of outgoingTargets(await page('GET', '/build.php?newdid=' + v.id + '&gid=16&tt=1&filter=2&subfilters=4'))) busy.add(key);
  }
  log.onTheirWay = busy.size;

  // 2. Troops at home.
  await pause(c.pageGapSeconds);
  let home = available(await page('GET', '/build.php?newdid=' + village.id + '&gid=16&tt=2'), slot);
  log.home = home;

  // 3. Animals of the free oases of the first stages.
  const taken = OasisService.loadTaken();
  const candidates = stages.flatMap(s => s.oases.map(o => ({ ...o, stage: s.stage })))
    .filter(o => !taken[o.x + '|' + o.y] && !busy.has(o.x + '|' + o.y));
  const smallest = Math.min(...Object.values(c.perStage));
  let targets = [];
  if (home >= smallest && candidates.length) {
    await pause(c.pageGapSeconds);
    const tiles = await blocksFor(village, candidates.map(o => o.x + '|' + o.y));
    const nowTaken = [];
    for (const o of candidates) {
      const t = tiles.get(o.x + '|' + o.y);
      if (!t) continue;
      const info = OasisService.oasisOf(t);
      if (!info || !info.free) {
        if (info) nowTaken.push(info);
        continue;
      }
      if (!OasisService.parseAnimals(t.text).length) targets.push(o);
    }
    if (nowTaken.length) OasisService.recordTaken(nowTaken);
    // 4. Closest first, as long as troops last.
    const chosen = [];
    let left = home;
    for (const o of targets) {
      const n = c.perStage[o.stage];
      if (left >= n) {
        chosen.push({ ...o, n });
        left -= n;
      }
    }
    // The map block may lag: check one, and all chosen if it differs.
    if (chosen.length) {
      const pick = chosen[Math.floor(Math.random() * chosen.length)];
      await pause(c.pageGapSeconds);
      const tile = await OasisService.tileAnimals(pick.x, pick.y);
      log.check = { key: pick.x + '|' + pick.y, empty: !tile.taken && !tile.animals.length };
      if (!log.check.empty) {
        const ok = [];
        for (const o of chosen) {
          await pause(c.pageGapSeconds);
          const t = o === pick ? tile : await OasisService.tileAnimals(o.x, o.y);
          if (t.taken) OasisService.recordTaken([o]);
          else if (!t.animals.length) ok.push(o);
        }
        chosen.splice(0, chosen.length, ...ok);
      }
    }
    targets = chosen;
  }
  log.targets = targets.map(o => ({ key: o.x + '|' + o.y, stage: o.stage, distance: o.distance, n: o.n }));

  // 4. Send (or only log).
  log.sent = [];
  for (const o of targets) {
    const key = o.x + '|' + o.y;
    if (!c.send) continue;
    await pause(c.sendGapSeconds);
    try {
      const arrival = await sendRaid(village, key, o.n, slot);
      state.raids.push({ key, village: village.name, n: o.n, unit: c.unit, stage: o.stage, sentAt: Date.now(), arrival });
      log.sent.push(key);
      home -= o.n;
    } catch (e) {
      log.error = key + ': ' + e.message;
      sails.log.warn('autoraid: send to ' + key + ' failed: ' + e.message);
      break;
    }
  }
  writeState();

  // 5. Reports.
  try {
    if (c.send) log.reportsRead = await readReports();
  } catch (e) {
    log.reportsError = e.message;
  }
  state.lastRound = log;
  writeState();
  sails.log.info('autoraid: ' + (c.send ? '' : 'DRY RUN ') + village.name + ' home ' + log.home + ', on their way ' + log.onTheirWay
    + ', ' + (c.send ? 'sent ' + log.sent.length : 'would send ' + log.targets.length) + ' (' + log.targets.map(t => t.key + ' ' + t.n).join(', ') + ')'
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

// Totals of the reports read, per stage of the raided oasis (from the raids sent here).
function stats() {
  const stageOf = key => (state.raids.find(r => r.key === key) || {}).stage || null;
  const byStage = {};
  for (const r of state.reports) {
    const s = stageOf(r.key) || 'other';
    const b = byStage[s] = byStage[s] || { reports: 0, bounty: 0, heroBonus: 0, deadUnits: 0, withAnimals: 0 };
    b.reports++;
    b.bounty += r.bounty;
    b.heroBonus += r.heroBonus;
    b.deadUnits += Object.values(r.dead).reduce((a, n) => a + n, 0);
    if (Object.keys(r.found).length) b.withAnimals++;
  }
  return byStage;
}

module.exports = {
  start: function () {
    if (!cfg().enabled) return;
    readState();
    sails.log.info('autoraid: on for ' + cfg().village + (cfg().send ? '' : ' (DRY RUN, nothing is sent)'));
    loop();
  },

  // One round now (npm run autoraid): same as the loop does.
  round: function () {
    readState();
    return OasisService.serial(round);
  },

  status: function () {
    return {
      enabled: cfg().enabled,
      send: cfg().send,
      village: cfg().village,
      lastRound: state.lastRound,
      raidsSent: state.raids.length,
      onTheirWay: state.raids.filter(r => r.arrival && r.arrival * 1000 > Date.now()).length,
      reportsRead: state.reports.length,
      byStage: stats(),
      lastReports: state.reports.slice(-10),
    };
  },

  parseReport,
  outgoingTargets,
  available,
  confirmForm,
};
