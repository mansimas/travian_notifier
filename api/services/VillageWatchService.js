/**
 * VillageWatchService
 *
 * Population of the player villages around us, to tell active players from inactive ones and
 * to see their active hours. Every everyMinutes (random in the range) the map blocks within
 * radius fields of the village are read (OasisService.coverArea, about 9 requests; every ~15 min) and the
 * population of every player village of at least minPop is noted. A village once noted stays
 * watched, also below minPop.
 * Kept in .tmp/villagewatch.json, KEEP_DAYS:
 *   snaps: [unix seconds] of every snapshot;
 *   villages: { "x|y": { did, uid, player, alliance, tribe, name, first, last, pops: [[t, pop]] } }
 *     pops only when it changed (the first entry is when it was first seen), owner changes in
 *     owners: [[t, uid, player]].
 * Growth seen in a snapshot happened since the snapshot before: when a building finished, not
 * when the player clicked, but a player who never grows is not playing.
 * analysis() says per village and per player: active (grew in the last ACTIVE_HOURS),
 * slow (in the last INACTIVE_HOURS), inactive (not in INACTIVE_HOURS, watched that long),
 * unknown (watched too short), and the local hours (config timezone) growth was seen in.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(process.cwd(), '.tmp', 'villagewatch.json');
const KEEP_DAYS = 30;
const ACTIVE_HOURS = 24;
const INACTIVE_HOURS = 72;
const MINUTE = 60 * 1000;

const cfg = () => sails.config.travian.villageWatch;
const now = () => Math.floor(Date.now() / 1000);
const wrap = v => ((((v + 200) % 401) + 401) % 401) - 200;

let data = null;

function load() {
  if (!data) {
    try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { data = { snaps: [], villages: {} }; }
  }
  return data;
}

function save() {
  const cut = now() - KEEP_DAYS * 24 * 3600;
  data.snaps = data.snaps.filter(t => t >= cut);
  for (const [key, v] of Object.entries(data.villages)) {
    if (v.last < cut) { delete data.villages[key]; continue; }
    // Keep the last change before the cut, it is the population at the cut.
    const i = v.pops.findIndex(([t]) => t >= cut);
    if (i > 1) v.pops = v.pops.slice(i - 1);
    else if (i < 0) v.pops = v.pops.slice(-1);
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data));
}

// Player village tile -> { x, y, did, uid, name, player, alliance, tribe, pop }, or null.
// uid 1 is the Natars, uid 0 nature.
function villageOf(t) {
  if (!(t.did > 0) || !(t.uid > 1)) return null;
  const text = t.text || '';
  const field = key => { const m = text.match(new RegExp('\\{k\\.' + key + '\\}\\s*([^<{]*)')); return m ? m[1].trim() : null; };
  const pop = Number(field('einwohner'));
  if (!Number.isFinite(pop)) return null;
  const tribe = text.match(/\{k\.volk\}\s*\{a\.v(\d+)\}/);
  return {
    x: t.position.x,
    y: t.position.y,
    did: t.did,
    uid: t.uid,
    name: (t.title || '').replace(/^\{k\.dt\}\s*/, ''),
    player: field('spieler'),
    alliance: field('allianz') || null,
    tribe: tribe ? Number(tribe[1]) : null,
    pop,
  };
}

async function snapshot() {
  const c = cfg();
  const village = await OasisService.findVillage(c.village);
  const t = now();
  const seen = new Map();
  const requests = await OasisService.coverArea(village, c.radius, tile => {
    const v = villageOf(tile);
    if (v && Math.hypot(wrap(v.x - village.x), wrap(v.y - village.y)) <= c.radius) seen.set(v.x + '|' + v.y, v);
  });
  load();
  let added = 0;
  for (const [key, v] of seen) {
    let w = data.villages[key];
    if (!w) {
      if (v.pop < c.minPop) continue;
      w = data.villages[key] = { did: v.did, uid: v.uid, first: t, pops: [[t, v.pop]] };
      added++;
    } else if (w.uid !== v.uid) {
      (w.owners = w.owners || []).push([t, v.uid, v.player]);
      w.uid = v.uid;
    }
    Object.assign(w, { name: v.name, player: v.player, alliance: v.alliance, tribe: v.tribe, last: t });
    if (w.pops[w.pops.length - 1][1] !== v.pop) w.pops.push([t, v.pop]);
  }
  data.snaps.push(t);
  data.center = { name: village.name, x: village.x, y: village.y, radius: c.radius, minPop: c.minPop };
  save();
  sails.log.verbose('villagewatch: ' + seen.size + ' villages seen, ' + Object.keys(data.villages).length + ' watched (' + added + ' new), ' + requests + ' requests');
  return { time: new Date(t * 1000).toISOString(), requests, seen: seen.size, watched: Object.keys(data.villages).length, added };
}

const hourOf = t => Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: sails.config.travian.timezone }).format(new Date(t * 1000)));

function statusOf(lastGrowth, watchedHours, at) {
  if (lastGrowth && at - lastGrowth <= ACTIVE_HOURS * 3600) return 'active';
  if (lastGrowth && at - lastGrowth <= INACTIVE_HOURS * 3600) return 'slow';
  return watchedHours >= INACTIVE_HOURS ? 'inactive' : 'unknown';
}

// { center, snaps, from, to, villages: [...], players: [...] }; filter by status.
function analysis({ status } = {}) {
  load();
  const at = now();
  const { center } = data;
  const villages = Object.entries(data.villages).map(([key, w]) => {
    const [x, y] = key.split('|').map(Number);
    const growth = []; // [t, gained]
    let drops = 0;
    for (let i = 1; i < w.pops.length; i++) {
      const d = w.pops[i][1] - w.pops[i - 1][1];
      if (d > 0) growth.push([w.pops[i][0], d]);
      else drops++;
    }
    const pop = w.pops[w.pops.length - 1][1];
    const popAt = t => { let p = w.pops[0][1]; for (const [tt, pp] of w.pops) if (tt <= t) p = pp; return p; };
    const lastGrowth = growth.length ? growth[growth.length - 1][0] : null;
    const watchedHours = Math.round((w.last - w.first) / 360) / 10;
    return {
      x, y, did: w.did, uid: w.uid, name: w.name, player: w.player, alliance: w.alliance, tribe: w.tribe,
      distance: center ? Math.round(Math.hypot(wrap(x - center.x), wrap(y - center.y)) * 10) / 10 : null,
      pop,
      gained24h: pop - popAt(at - 24 * 3600),
      gained72h: pop - popAt(at - 72 * 3600),
      lastGrowth: lastGrowth && new Date(lastGrowth * 1000).toISOString(),
      hoursSinceGrowth: lastGrowth ? Math.round((at - lastGrowth) / 360) / 10 : null,
      watchedHours,
      gone: w.last < (data.snaps[data.snaps.length - 1] || 0), // not on the map in the last snapshot
      drops, // times the population went down (catapults, conquest)
      owners: w.owners,
      status: statusOf(lastGrowth, watchedHours, at),
      growth,
    };
  });
  const byPlayer = new Map();
  for (const v of villages) {
    const p = byPlayer.get(v.uid) || { uid: v.uid, player: v.player, alliance: v.alliance, tribe: v.tribe, villages: [], pop: 0, gained24h: 0, gained72h: 0, hours: Array(24).fill(0), lastGrowthT: 0, watchedHours: 0 };
    p.villages.push(v.x + '|' + v.y);
    p.pop += v.pop;
    p.gained24h += v.gained24h;
    p.gained72h += v.gained72h;
    p.watchedHours = Math.max(p.watchedHours, v.watchedHours);
    for (const [t] of v.growth) {
      p.hours[hourOf(t)]++;
      p.lastGrowthT = Math.max(p.lastGrowthT, t);
    }
    byPlayer.set(v.uid, p);
  }
  const players = [...byPlayer.values()].map(({ lastGrowthT, ...p }) => ({
    ...p,
    lastGrowth: lastGrowthT ? new Date(lastGrowthT * 1000).toISOString() : null,
    status: statusOf(lastGrowthT || null, p.watchedHours, at),
  }));
  for (const v of villages) {
    v.playerStatus = byPlayer.get(v.uid) && players.find(p => p.uid === v.uid).status;
    v.growth = v.growth.map(([t, d]) => [new Date(t * 1000).toISOString(), d]);
  }
  const keep = list => status ? list.filter(e => e.status === status) : list;
  return {
    center,
    timezone: sails.config.travian.timezone,
    snaps: data.snaps.length,
    from: data.snaps.length ? new Date(data.snaps[0] * 1000).toISOString() : null,
    to: data.snaps.length ? new Date(data.snaps[data.snaps.length - 1] * 1000).toISOString() : null,
    counts: ['active', 'slow', 'inactive', 'unknown'].reduce((o, s) => ({ ...o, [s]: villages.filter(v => v.status === s).length }), {}),
    villages: keep(villages).sort((a, b) => a.distance - b.distance),
    players: keep(players).sort((a, b) => b.pop - a.pop),
  };
}

// Compact analysis() for the plugin: { at, villages: { "x|y": [player, pop, h, watched, status] } },
// h = hours since the player (any of their villages) last grew, null when never seen growing;
// watched = hours the player has been watched; status of the player.
function activity() {
  const a = analysis();
  const players = new Map(a.players.map(p => [p.uid, p]));
  const villages = {};
  for (const v of a.villages) {
    if (v.gone) continue;
    const p = players.get(v.uid);
    const h = p.lastGrowth ? Math.round((Date.now() - Date.parse(p.lastGrowth)) / 360000) / 10 : null;
    villages[v.x + '|' + v.y] = [v.player, v.pop, h, p.watchedHours, p.status];
  }
  return { at: a.to, villages };
}

async function loop() {
  for (;;) {
    try {
      await OasisService.serial(snapshot);
    } catch (e) {
      sails.log.error('villagewatch: snapshot failed: ' + e.message);
    }
    const [a, b] = cfg().everyMinutes;
    await new Promise(r => setTimeout(r, (a + Math.random() * (b - a)) * MINUTE));
  }
}

module.exports = {
  start: function () {
    if (!cfg().enabled) return;
    sails.log.verbose('villagewatch: on, ' + cfg().radius + ' fields around ' + (cfg().village || 'the first village') + ', villages from ' + cfg().minPop + ' population');
    loop();
  },
  // One snapshot now (npm run villages -- snap).
  snapshot: () => OasisService.serial(snapshot),
  analysis,
  activity,
  villageOf,
};
