/**
 * RaidPlanService
 *
 * Armies for oases with animals, by the rules the player set (2026-10-19):
 *  - only the animals there now count (no respawn on the way);
 *  - infantry (Mercenary, Bowman) first: trips of at most MAX_INF_HOURS, crop oases first, then
 *    the closest; the smallest army from INF_MIN up whose losses stay within INF_LOSS (70%) of the
 *    kill bonus; until fewer than INF_MIN are left;
 *  - then cavalry (Steppe Rider, Marksman, Marauder as one mixed group, at least CAV_MIN): never
 *    into crop oases, only where animals weak against horses outweigh the strong ones 1.5:1
 *    (points per animal), losses within CAV_LOSS (CAV_LOSS_WEAK_ONLY where every animal is weak
 *    against horses: rat, spider, boar, wolf), or at most one horse lost (then also where the
 *    1.5:1 test fails); per oasis the army with the most profit per troop-hour; the oases that
 *    return the most (kill bonus + loot - losses) first;
 *  - an oasis that is not crop and fails the 1.5:1 test is not raided at all;
 *  - nor one whose kill bonus is under MIN_GAIN: not worth the troops' time.
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
const CAV_MIN = 30;
const INF_LOSS = 0.7;
const CAV_LOSS = 0.2;
const CAV_LOSS_WEAK_ONLY = 0.4; // no animal strong against horses there at all
const MAX_INF_HOURS = 2;
const MIN_GAIN = 1000;
const LOOT = 1300; // typical loot per raid (real reports), counted in the cavalry profit only
const WEAK_VS_CAV = { u31: 1, u32: 2, u35: 5, u36: 7 };
const STRONG_VS_CAV = { u33: 3, u34: 4, u37: 10, u38: 20, u39: 15, u40: 20 };
const MAP_SIZE = 401;

const wrap = v => ((((v + 200) % MAP_SIZE) + MAP_SIZE) % MAP_SIZE) - 200;
const points = (animals, table) => animals.reduce((s, a) => s + (table[a.unit] || 0) * a.count, 0);
const CAV_RATIO = 1.5; // weak : strong points at least this
const cavAllowed = animals => points(animals, WEAK_VS_CAV) >= CAV_RATIO * points(animals, STRONG_VS_CAV);
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

// Best army of one kind against an oasis, or null. village: { x, y }. oneLossOnly: only armies
// that lose at most one unit count.
function planKind(village, o, left, kind, oneLossOnly) {
  if (B.simulate({ u66: 1e6 }, o.animals).gain < MIN_GAIN) return null; // the bonus does not depend on the army
  const distance = Math.hypot(wrap(o.x - village.x), wrap(o.y - village.y));
  const hoursOf = army => distance / Math.min(...Object.keys(army).map(u => B.UNITS[u].speed));
  const orders = kind === 'inf' ? [INF] : [CAV.strongFirst, CAV.cheapFirst];
  const lossLimit = kind === 'inf' ? INF_LOSS : points(o.animals, STRONG_VS_CAV) ? CAV_LOSS : CAV_LOSS_WEAK_ONLY;
  let best = null;
  for (const order of orders) {
    const have = order.reduce((s, u) => s + (left[u] || 0), 0);
    for (let n = kind === 'inf' ? INF_MIN : CAV_MIN; n <= have; n = Math.max(n + 1, Math.round(n * 1.08))) {
      const army = fill(left, order, n);
      if (!army) break;
      const hours = hoursOf(army);
      if (kind === 'inf' && hours > MAX_INF_HOURS) return null;
      const r = B.simulate(army, o.animals);
      if (!r.win) continue;
      const net = r.gain + (kind === 'cav' ? Math.min(LOOT, r.carry || Infinity) : 0) - r.lostRes;
      const oneLoss = kind === 'cav' && r.totalDeaths <= 1; // one horse lost is fine anyway
      if (net <= 0 || (oneLossOnly && !oneLoss) || (!oneLoss && r.lostRes > lossLimit * r.gain)) continue;
      const plan = {
        army, kind, hours, distance, net,
        deaths: Object.fromEntries(Object.entries(r.deaths || {}).filter(([, d]) => d > 0)),
        totalDeaths: r.totalDeaths, lostRes: r.lostRes, gain: r.gain,
        rate: net / (cost(army) * 2 * Math.max(hours, 0.25)),
      };
      if (kind === 'inf') return plan; // the smallest that fits
      if (!best || plan.rate > best.rate) best = plan;
    }
  }
  return best;
}

// oases: [{ x, y, bonus, animals: [{ unit, count }] }] with animals; troops: { uNN: n } at home.
// Returns [{ oasis, plan }] in sending order.
function plan(village, oases, troops) {
  const left = { ...troops };
  const out = [];
  const used = new Set();
  const take = (o, p) => {
    for (const [u, n] of Object.entries(p.army)) left[u] -= n;
    out.push({ oasis: o, plan: p });
    used.add(o);
  };
  const distance = o => Math.hypot(wrap(o.x - village.x), wrap(o.y - village.y));
  const allowed = oases.filter(o => isCrop(o) || cavAllowed(o.animals));
  for (const o of [...allowed].sort((a, b) => (isCrop(b) - isCrop(a)) || distance(a) - distance(b))) {
    if (INF.reduce((s, u) => s + (left[u] || 0), 0) < INF_MIN) break;
    const p = planKind(village, o, left, 'inf');
    if (p) take(o, p);
  }
  // Horses: where the 1.5:1 test passes, or failing it, at most one horse lost. Most return first.
  const cavPlan = o => planKind(village, o, left, 'cav', !cavAllowed(o.animals));
  const cavOrder = oases.filter(o => !used.has(o) && !isCrop(o))
    .map(o => ({ o, net: (cavPlan(o) || { net: -Infinity }).net }))
    .filter(x => x.net > -Infinity)
    .sort((a, b) => b.net - a.net);
  for (const { o } of cavOrder) {
    const p = cavPlan(o);
    if (p) take(o, p);
  }
  return out;
}

module.exports = { plan, cavAllowed, isCrop, B, INF_MIN, CAV_MIN };
