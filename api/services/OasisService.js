/**
 * OasisService
 *
 * The oasis scan of the oasis-dot browser plugin, run from the server with the notifier's login:
 *  - scan(village): every oasis within SCAN_RADIUS fields of a village from a few map blocks
 *    (map/position). Free oases (nature, animals respawn) sorted by distance and split into
 *    STAGES equal stages; oases taken by players listed apart. Kept in .tmp/oases-<x>_<y>.json
 *    and reused for SCAN_MAX_AGE_DAYS.
 *  - stageAnimals(stage): the animals of one stage. One map block around the village holds a
 *    near stage; its tooltip texts list each oasis's animals. CHECK_COUNT oases are compared
 *    with tile-details first; on any difference (or no animal lists) every oasis is asked one
 *    by one.
 * Oases seen taken by a player even once are remembered in .tmp/oasis-taken.json and left out
 * of every stage from then on, also after the owner gives them up: only never-owned oases
 * (nature only) are listed and asked about.
 * Requests go one at a time with pauses, and only one job runs at a time.
 */
const fs = require('fs');
const path = require('path');

const SCAN_RADIUS = 30;
const STAGES = 10;
const ZOOM_LEVEL = 3; // largest map block per request
const MAX_REQUESTS = 40;
const SCAN_MAX_AGE_DAYS = 7;
const BLOCK_GAP_MS = 3000;
const BLOCK_JITTER_MS = 1500;
const CHECK_COUNT = 2;
const TILE_GAP_MS = 500;
const TILE_JITTER_MS = 400;
const MAP_SIZE = 401; // map wraps around from -200 to 200

const wrap = v => ((((v + 200) % MAP_SIZE) + MAP_SIZE) % MAP_SIZE) - 200; // also the shortest signed difference
const pause = (gap, jitter) => new Promise(r => setTimeout(r, gap + Math.random() * jitter));
const TAKEN_FILE = path.join(process.cwd(), '.tmp', 'oasis-taken.json');
const scanFile = village => path.join(process.cwd(), '.tmp', 'oases-' + village.x + '_' + village.y + '.json');

let running = null; // the job in progress, so two never run at once

function serial(job) {
  const next = (running || Promise.resolve()).catch(() => {}).then(job);
  running = next.finally(() => { if (running === next) running = null; });
  return next;
}

// POST to the game api as the page does; logs in again when the session has run out.
async function api(apiPath, data) {
  const send = () => TravianService.request('POST', '/api/v1/' + apiPath, {
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
  });
  const parse = res => { try { return res.status === 200 ? JSON.parse(res.body) : null; } catch (e) { return null; } };
  let res = await send();
  let json = parse(res);
  if (!json) {
    await TravianService.login();
    res = await send();
    json = parse(res);
  }
  if (!json) throw new TravianService.Problem('page', apiPath + ' failed (HTTP ' + res.status + '): ' + res.body.slice(0, 200));
  return json;
}

// "x|y" -> { owner, alliance, seen }: every oasis ever seen owned by a player, seen = first time.
function loadTaken() {
  try { return JSON.parse(fs.readFileSync(TAKEN_FILE, 'utf8')); } catch (e) { return {}; }
}

function recordTaken(list) {
  const taken = loadTaken();
  let added = 0;
  for (const o of list) {
    const key = o.x + '|' + o.y;
    const before = taken[key];
    if (!before) added++;
    taken[key] = {
      owner: o.owner || (before && before.owner) || null,
      alliance: o.alliance || (before && before.alliance) || null,
      seen: before ? before.seen : new Date().toISOString(),
    };
  }
  fs.mkdirSync(path.dirname(TAKEN_FILE), { recursive: true });
  fs.writeFileSync(TAKEN_FILE, JSON.stringify(taken, null, 1));
  if (added) sails.log.verbose('oases: ' + added + ' newly seen taken');
  return taken;
}

const requestBlock = (x, y) => api('map/position', { data: { x, y, zoomLevel: ZOOM_LEVEL, ignorePositions: [] } });

// Villages with coordinates, from dorf1.php: [{ id, name, x, y }].
async function villages() {
  const { viewData } = await TravianService.read();
  const list = (viewData.ownPlayer.villageList || []).flatMap(entry => entry.villages || [entry]);
  return list.map(v => ({ id: v.id, name: v.name, x: v.x, y: v.y }));
}

// The village by name (any case), or the first one.
async function findVillage(name) {
  const list = await villages();
  const village = name ? list.find(v => v.name.toLowerCase() === String(name).toLowerCase()) : list[0];
  if (!village) throw new Error('no village "' + name + '", there are: ' + list.map(v => v.name).join(', '));
  return village;
}

// Oasis tile -> { x, y, free, owner, alliance, bonus }, or null for any other tile.
// Titles: {k.fo} unoccupied oasis, {k.bt} occupied oasis.
function oasisOf(tile) {
  const title = tile.title || '';
  const free = title.includes('{k.fo}');
  if (!free && !title.includes('{k.bt}')) return null;
  const text = tile.text || '';
  const bonus = {};
  for (const m of text.matchAll(/\{a\.r(\d)\}\s*(\d+)\s*%/g)) bonus['r' + m[1]] = Number(m[2]);
  const owner = text.match(/\{k\.spieler\}\s*([^<{]+)/);
  const alliance = text.match(/\{k\.allianz\}\s*([^<{]+)/);
  return {
    x: tile.position.x,
    y: tile.position.y,
    free,
    owner: free || !owner ? null : owner[1].trim(),
    alliance: free || !alliance ? null : alliance[1].trim() || null,
    bonus,
  };
}

// Animals in an html snippet: [{ unit, count }]. The count is the first number between the
// icon and the next icon (works for tooltip texts and the tile-details table rows).
function parseAnimals(html) {
  const found = new Map();
  const icons = [...(html || '').matchAll(/class="[^"]*\bunit\s+(u\d+)\b[^"]*"/g)];
  icons.forEach((m, i) => {
    const unit = m[1];
    if (!/^u(3[1-9]|40)$/.test(unit) || found.has(unit)) return;
    const after = html.slice(m.index + m[0].length, i + 1 < icons.length ? icons[i + 1].index : undefined);
    const text = after.replace(/^[^>]*>/, '').replace(/<[^>]*>/g, ' ').replace(/[‪-‮‎‏]/g, '');
    const n = text.match(/\d[\d.,]*/);
    if (n) found.set(unit, parseInt(n[0].replace(/[.,]/g, ''), 10));
  });
  return [...found].map(([unit, count]) => ({ unit, count }));
}

// { animals, taken }: a taken oasis links its owner's profile.
async function tileAnimals(x, y) {
  const data = await api('map/tile-details', { x, y });
  const html = typeof data === 'string' ? data : (data && data.html) || '';
  if (/href="\/profile\//.test(html)) return { animals: [], taken: true };
  const start = html.indexOf('id="troop_info"');
  return { animals: parseAnimals(start < 0 ? html : html.slice(start, html.indexOf('</table>', start))), taken: false };
}

// Map blocks until every field within SCAN_RADIUS of the village was in one: the first block
// around the village, its size gives a grid over the area, a block on anything still missing.
async function scanBlocks(village) {
  const distance = (x, y) => Math.hypot(wrap(x - village.x), wrap(y - village.y));
  const needed = new Set();
  for (let dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
    for (let dy = -SCAN_RADIUS; dy <= SCAN_RADIUS; dy++) {
      if (Math.hypot(dx, dy) <= SCAN_RADIUS) needed.add(dx + '|' + dy); // offsets from the village
    }
  }
  const oases = new Map();
  let block = null; // { minX, maxX, minY, maxY }: fields a reply spans around its center
  const planned = [{ x: 0, y: 0 }];
  const blockMisses = c => {
    for (let dx = c.x + block.minX; dx <= c.x + block.maxX; dx++) {
      for (let dy = c.y + block.minY; dy <= c.y + block.maxY; dy++) {
        if (needed.has(wrap(dx) + '|' + wrap(dy))) return true;
      }
    }
    return false;
  };
  let requests = 0;
  while (needed.size) {
    if (requests >= MAX_REQUESTS) throw new Error('still ' + needed.size + ' fields unscanned after ' + requests + ' requests');
    let c = planned.shift();
    while (c && block && !blockMisses(c)) c = planned.shift();
    if (!c) {
      const [fx, fy] = [...needed][0].split('|').map(Number);
      c = { x: fx, y: fy };
    }
    const cx = wrap(village.x + c.x);
    const cy = wrap(village.y + c.y);
    if (requests) await pause(BLOCK_GAP_MS, BLOCK_JITTER_MS);
    const reply = await requestBlock(cx, cy);
    requests++;
    const tiles = (reply && reply.tiles) || [];
    if (!tiles.length) throw new Error('map reply without tiles');
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const t of tiles) {
      const dx = wrap(t.position.x - cx);
      const dy = wrap(t.position.y - cy);
      minX = Math.min(minX, dx); maxX = Math.max(maxX, dx);
      minY = Math.min(minY, dy); maxY = Math.max(maxY, dy);
      const o = oasisOf(t);
      if (o && distance(o.x, o.y) <= SCAN_RADIUS) oases.set(o.x + '|' + o.y, o);
    }
    if (!block) {
      block = { minX, maxX, minY, maxY };
      const axis = (lo, hi) => {
        const out = [];
        for (let v = -SCAN_RADIUS - lo; v - SCAN_RADIUS - lo < hi - lo + 1 + SCAN_RADIUS; v += hi - lo + 1) out.push(v);
        return out;
      };
      for (const x of axis(minX, maxX)) for (const y of axis(minY, maxY)) planned.push({ x, y });
    }
    const before = needed.size;
    for (let dx = minX; dx <= maxX; dx++) {
      for (let dy = minY; dy <= maxY; dy++) needed.delete(wrap(cx + dx - village.x) + '|' + wrap(cy + dy - village.y));
    }
    if (needed.size === before) throw new Error('map reply did not cover the asked area');
  }

  const list = [...oases.values()]
    .map(o => ({ ...o, distance: Math.round(distance(o.x, o.y) * 100) / 100 }))
    .sort((a, b) => a.distance - b.distance);
  const taken = recordTaken(list.filter(o => !o.free));
  const free = list.filter(o => o.free && !taken[o.x + '|' + o.y]);
  const stages = [];
  for (let i = 0; i < STAGES; i++) {
    const part = free.slice(Math.round(i * free.length / STAGES), Math.round((i + 1) * free.length / STAGES));
    if (!part.length) continue;
    stages.push({
      stage: stages.length + 1,
      minDistance: part[0].distance,
      maxDistance: part[part.length - 1].distance,
      oases: part.map(({ x, y, distance: d, bonus }) => ({ x, y, distance: d, bonus })),
    });
  }
  return {
    server: sails.config.travian.server,
    village,
    radius: SCAN_RADIUS,
    scanned: new Date().toISOString(),
    requests,
    counts: { all: list.length, free: free.length, occupied: list.filter(o => !o.free).length, wereTaken: list.filter(o => o.free).length - free.length },
    stages,
    occupied: list.filter(o => !o.free).map(({ x, y, distance: d, owner, alliance, bonus }) => ({ x, y, distance: d, owner, alliance, bonus })),
  };
}

// The saved scan of the village, or a new one when there is none, it is too old, or fresh is set.
async function scan(village, { fresh = false } = {}) {
  const file = scanFile(village);
  if (!fresh) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - Date.parse(saved.scanned) < SCAN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) {
        recordTaken(saved.occupied);
        return saved;
      }
    } catch (e) { /* none yet */ }
  }
  const result = await scanBlocks(village);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 1));
  sails.log.verbose('oases: scanned ' + village.name + ', ' + result.counts.free + ' free / ' + result.counts.occupied + ' taken');
  return result;
}

const sameAnimals = (a, b) => a.length === b.length && a.every(t => b.some(u => u.unit === t.unit && u.count === t.count));

async function stageAnimals(village, stage) {
  const started = Date.now();
  const wasTaken = loadTaken();
  const skipped = stage.oases.filter(o => wasTaken[o.x + '|' + o.y]).map(o => ({ x: o.x, y: o.y, ...wasTaken[o.x + '|' + o.y] }));
  let oases = stage.oases.filter(o => !wasTaken[o.x + '|' + o.y]).map(o => ({ ...o, animals: null }));
  const reply = await requestBlock(village.x, village.y);
  const byKey = new Map(((reply && reply.tiles) || []).map(t => [t.position.x + '|' + t.position.y, t]));
  // Taken since the scan: remembered and left out.
  const nowTaken = oases.map(o => byKey.get(o.x + '|' + o.y)).map(t => t && oasisOf(t)).filter(o => o && !o.free);
  if (nowTaken.length) {
    recordTaken(nowTaken);
    skipped.push(...nowTaken.map(({ x, y, owner, alliance }) => ({ x, y, owner, alliance })));
    oases = oases.filter(o => !nowTaken.some(t => t.x === o.x && t.y === o.y));
  }
  let listed = 0;
  for (const o of oases) {
    const t = byKey.get(o.x + '|' + o.y);
    if (!t) continue;
    o.animals = parseAnimals(t.text);
    if (o.animals.length) listed++;
  }
  // Check against single-tile data, oases with animals first.
  const checks = [];
  const sample = [...oases.filter(o => o.animals && o.animals.length), ...oases.filter(o => o.animals && !o.animals.length)];
  for (const o of listed ? sample.slice(0, CHECK_COUNT) : []) {
    await pause(TILE_GAP_MS, TILE_JITTER_MS);
    const { animals: tile } = await tileAnimals(o.x, o.y);
    checks.push({ x: o.x, y: o.y, block: o.animals, tile, same: sameAnimals(o.animals, tile) });
    o.animals = tile;
    o.checked = true;
  }
  const ok = listed > 0 && checks.every(c => c.same);
  for (const o of oases) {
    if (o.checked || (ok && o.animals)) continue;
    await pause(TILE_GAP_MS, TILE_JITTER_MS);
    const tile = await tileAnimals(o.x, o.y);
    o.animals = tile.animals;
    o.checked = true;
    if (tile.taken) {
      o.taken = true;
      recordTaken([o]);
      skipped.push({ x: o.x, y: o.y, owner: null, alliance: null });
    }
  }
  oases = oases.filter(o => !o.taken);
  return {
    village,
    stage: stage.stage,
    time: new Date().toISOString(),
    seconds: (Date.now() - started) / 1000,
    source: ok ? 'map block' : listed ? 'one by one (map block differed)' : 'one by one (map block had no animals)',
    checks,
    oases,
    skipped, // taken now or before: not listed
  };
}

module.exports = {
  // { scan, animals } for the village (name, or the first one) and stage number (1 = closest).
  // fresh: scan again even when a recent scan is saved.
  stage: function ({ village: name, stage = 1, fresh = false } = {}) {
    return serial(async () => {
      const village = await findVillage(name || sails.config.travian.oasisVillage);
      const result = await scan(village, { fresh });
      const found = result.stages.find(s => s.stage === Number(stage));
      if (!found) throw new Error('no stage ' + stage + ', there are 1-' + result.stages.length);
      return { scan: result, animals: await stageAnimals(village, found) };
    });
  },

  parseAnimals,
  oasisOf,
  serial,
  scan,
  findVillage,
  requestBlock,
  tileAnimals,
  recordTaken,
  loadTaken,
  sameAnimals,
};
