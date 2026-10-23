/**
 * RaidPlanService
 *
 * Armies for oases with animals, by the rules the player set (2026-10-19):
 *  - only the animals there now count (no respawn on the way);
 *  - infantry (Mercenary, Bowman) first: trips of at most MAX_INF_HOURS, crop oases first, then
 *    the closest; the smallest army from INF_MIN up whose losses stay within INF_LOSS (50%; 70% until
 *    2026-10-23, when mansim2's Mercenaries lost 156,600 for 306,453 in a day) of the kill bonus;
 *    until fewer than INF_MIN are left;
 *  - then cavalry (Steppe Rider, Marksman, Marauder as one mixed group, at least CAV_MIN_BY_STAGE
 *    for the oasis' stage: 60 / 80 / 80 / 100 / 120 / 140 / 160 per two stages, 2026-10-23):
 *    never into crop oases, nor into an oasis our raids hit less than horseRestMinutes ago
 *    (o.resting: it refills on the way), only where the points of the animals weak against horses are at least
 *    CAV_RATIO_AT_MAX (2) times the points of the strong ones; losses within cavLoss(n) of
 *    the kill bonus, with no exception (2026-10-20: raids planned to lose more, by the old
 *    one-loss rule, lost resources overall); per oasis the army with the most profit per
 *    troop-hour, or below CAV_RATIO (5) times the smallest army that fits (up to CAV_MAX, so a
 *    full group only when nothing smaller does; 2026-10-20: 600 horses no longer go at 4 boars
 *    and 1 bear); the oases that return the most (kill bonus + loot - losses) first;
 *  - the points test comes first for horses, in every pass, with no exception (2026-10-20: 252
 *    horses went at 1 rat + 2 elephants because only one loss was predicted; 8 elephants were
 *    there by arrival, 9 horses died);
 *  - the points test only keeps horses out: infantry may raid any oasis;
 *  - no oasis whose kill bonus is under MIN_GAIN: not worth the troops' time;
 *  - no horse group over CAV_MAX.
 * Troops left after that get a second pass (2026-10-20) over the oases still free: infantry trips
 * up to EXTRA_INF_HOURS, cavalry armies grown by EXTRA_CAV_GROWTH per stage band beyond stage 4
 * (stages 5-6 x1.2, 7-8 x1.44, 9-10 x1.728, ...).
 * Battles are simulated with lib/battle.js, a copy of the browser plugin's simulator.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'battle.js'), 'utf8'), sandbox);
const B = sandbox.window.OasisBattle;

const INF = ['u61', 'u62'];
const CAV = { strongFirst: ['u66', 'u64', 'u65'], cheapFirst: ['u64', 'u65', 'u66'] };
const INF_MIN = 200;
const CAV_MIN = 40;
// Fewer horses lost too many per raid (2-5 each, 2026-10-20; groups under 100 lost 1.7% a raid against
// 0.8% for 100-199, 2026-10-23: stages 1-4 from 40/60 to 60/80): smallest horse group per stage.
const CAV_MIN_BY_STAGE = { 1: 60, 2: 60, 3: 80, 4: 80, 5: 80, 6: 80, 7: 100, 8: 100, 9: 120, 10: 120, 11: 140, 12: 140, 13: 160, 14: 160 };
const cavMin = stage => CAV_MIN_BY_STAGE[stage] || CAV_MIN;
const CAV_MAX = 600; // no bigger horse group (2026-10-20)
const INF_LOSS = 0.5;
// Share of the kill bonus a horse group of n may lose (2026-10-20): over 400 50%, 200-400 40%, under 200 30%.
const cavLoss = n => (n > 400 ? 0.5 : n >= 200 ? 0.4 : 0.3);
const MAX_INF_HOURS = 2;
const EXTRA_INF_HOURS = 4;
const EXTRA_CAV_GROWTH = 1.2;
const MIN_GAIN = 1000;
const LOOT = 1300; // typical loot per raid (real reports), counted in the cavalry profit only
const WEAK_VS_CAV = { u31: 1, u32: 2, u35: 5, u36: 7 };
const STRONG_VS_CAV = { u33: 3, u34: 4, u37: 10, u38: 20, u39: 15, u40: 40 };
const MAP_SIZE = 401;

const wrap = v => ((((v + 200) % MAP_SIZE) + MAP_SIZE) % MAP_SIZE) - 200;
const points = (animals, table) => animals.reduce((s, a) => s + (table[a.unit] || 0) * a.count, 0);
// Weak points at least this many times the strong points (2026-10-20): 100 rats + 100 spiders
// (300) against 1 elephant (40) is 7.5 times, horses may go.
const CAV_RATIO = 5;
const CAV_RATIO_AT_MAX = 2; // below CAV_RATIO: the smallest army that fits
const ratioAtLeast = (animals, ratio) => points(animals, WEAK_VS_CAV) >= ratio * points(animals, STRONG_VS_CAV);
const cavAllowed = animals => ratioAtLeast(animals, CAV_RATIO_AT_MAX);
const isCrop = o => !!(o.bonus && o.bonus.r4);
const cost = army => Object.entries(army).reduce((s, [u, n]) => s + n * B.UNITS[u].cost, 0);

// Army of `total` units taken from `left` in this order, or null if there are not that many.
function fill(left, order, total) {
  const army = {};
  for (const u of order) {
    const take = Math.min(total, left[u] || 0);
    if (take > 0) army[u] = take;
    total -= take;
  }
  return total > 0 ? null : army;
}

// Best army of one kind against an oasis, or null. village: { x, y }. maxInfHours: longest
// infantry trip.
function planKind(village, o, left, kind, maxInfHours = MAX_INF_HOURS) {
  if (kind === 'cav' && (o.resting || !cavAllowed(o.animals))) return null; // points first, always
  const smallest = kind === 'inf' || !ratioAtLeast(o.animals, CAV_RATIO); // between 2 and 5 times: the smallest that fits
  if (B.simulate({ u66: 1e6 }, o.animals).gain < MIN_GAIN) return null; // the bonus does not depend on the army
  const distance = Math.hypot(wrap(o.x - village.x), wrap(o.y - village.y));
  const hoursOf = army => distance / Math.min(...Object.keys(army).map(u => B.UNITS[u].speed));
  const orders = kind === 'inf' ? [INF] : [CAV.strongFirst, CAV.cheapFirst];
  let best = null;
  for (const order of orders) {
    const have = order.reduce((s, u) => s + (left[u] || 0), 0);
    const top = kind === 'inf' ? have : Math.min(have, CAV_MAX);
    for (let n = kind === 'inf' ? INF_MIN : cavMin(o.stage); n <= top; n = n < top ? Math.min(top, Math.max(n + 1, Math.round(n * 1.08))) : n + 1) {
      const army = fill(left, order, n);
      if (!army) break;
      const hours = hoursOf(army);
      if (kind === 'inf' && hours > maxInfHours) return null;
      const r = B.simulate(army, o.animals);
      if (!r.win) continue;
      const net = r.gain + (kind === 'cav' ? Math.min(LOOT, r.carry || Infinity) : 0) - r.lostRes;
      if (net <= 0 || r.lostRes > (kind === 'inf' ? INF_LOSS : cavLoss(n)) * r.gain) continue;
      const plan = {
        army, kind, hours, distance, net,
        deaths: Object.fromEntries(Object.entries(r.deaths || {}).filter(([, d]) => d > 0)),
        totalDeaths: r.totalDeaths, lostRes: r.lostRes, gain: r.gain,
        rate: net / (cost(army) * 2 * Math.max(hours, 0.25)),
      };
      if (kind === 'inf') return plan; // the smallest that fits
      if (smallest) { // per horse order, the smaller one wins
        if (!best || n < Object.values(best.army).reduce((a, k) => a + k, 0)) best = plan;
        break;
      }
      if (!best || plan.rate > best.rate) best = plan;
    }
  }
  return best;
}

// Second pass: the cavalry army grown by EXTRA_CAV_GROWTH for every stage band beyond stage 4,
// as far as the troops left allow, and simulated again.
function grow(o, p, left) {
  const factor = EXTRA_CAV_GROWTH ** Math.max(0, Math.ceil((o.stage || 0) / 2) - 2);
  if (factor === 1) return p;
  const grown = Object.fromEntries(Object.entries(p.army).map(([u, n]) => [u, Math.min(left[u] || 0, Math.ceil(n * factor))]));
  const army = fill(grown, Object.keys(grown), Math.min(CAV_MAX, Object.values(grown).reduce((a, n) => a + n, 0)));
  const r = B.simulate(army, o.animals);
  if (!r.win) return p;
  return {
    ...p, army, net: r.gain + Math.min(LOOT, r.carry || Infinity) - r.lostRes,
    deaths: Object.fromEntries(Object.entries(r.deaths || {}).filter(([, d]) => d > 0)),
    totalDeaths: r.totalDeaths, lostRes: r.lostRes, gain: r.gain,
  };
}

// oases: [{ x, y, stage, bonus, animals: [{ unit, count }] }] with animals; troops: { uNN: n } at
// home. extra: false leaves out the second pass. Returns [{ oasis, plan }] in sending order.
function plan(village, oases, troops, { extra = true } = {}) {
  const left = { ...troops };
  const out = [];
  const used = new Set();
  const take = (o, p) => {
    for (const [u, n] of Object.entries(p.army)) left[u] -= n;
    out.push({ oasis: o, plan: p });
    used.add(o);
  };
  const distance = o => Math.hypot(wrap(o.x - village.x), wrap(o.y - village.y));
  const infPass = (maxHours, pass) => {
    for (const o of [...oases].sort((a, b) => (isCrop(b) - isCrop(a)) || distance(a) - distance(b))) {
      if (INF.reduce((s, u) => s + (left[u] || 0), 0) < INF_MIN) break;
      if (used.has(o)) continue;
      const p = planKind(village, o, left, 'inf', maxHours);
      if (p) take(o, { ...p, pass });
    }
  };
  // Horses: only where the points test passes. Most return first.
  const cavPass = pass => {
    const cavPlan = o => {
      const p = planKind(village, o, left, 'cav');
      return p && (pass > 1 ? grow(o, p, left) : p);
    };
    const cavOrder = oases.filter(o => !used.has(o) && !isCrop(o))
      .map(o => ({ o, net: (cavPlan(o) || { net: -Infinity }).net }))
      .filter(x => x.net > -Infinity)
      .sort((a, b) => b.net - a.net);
    let sent = 0;
    for (const { o } of cavOrder) {
      const p = cavPlan(o);
      if (p) take(o, { ...p, pass }), sent++;
    }
    return sent;
  };
  infPass(MAX_INF_HOURS, 1);
  cavPass(1);
  if (!extra) return out;
  // Second pass for the troops still at home.
  infPass(EXTRA_INF_HOURS, 2);
  if (CAV.cheapFirst.reduce((s, u) => s + (left[u] || 0), 0) >= CAV_MIN) cavPass(2);
  return out;
}

module.exports = { plan, cavAllowed, isCrop, cavMin, B, INF_MIN, CAV_MIN };
