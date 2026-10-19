// Copy of oasis-dot/battle.js (the browser plugin), loaded by api/services/RaidPlanService.js.
// Travian battle simulator for raiding oases (raid vs. animals).
// Exposed as window.OasisBattle; loaded before content.js in the MAIN world.
(function () {
  // att, dInf, dCav, cav (is cavalry), carry, cost (sum of 4 resources), use
  // (false = never send to an oasis: scouts, siege, chiefs, settlers), speed
  // (fields per hour), upkeep (crop per hour, used by smithy upgrades).
  const UNITS = {
    // Huns
    u61: { att: 35, dInf: 40, dCav: 30, cav: false, carry: 50, cost: 290, use: true, speed: 6, upkeep: 1 }, // Mercenary
    u62: { att: 50, dInf: 30, dCav: 10, cav: false, carry: 30, cost: 370, use: true, speed: 6, upkeep: 1 }, // Bowman
    u63: { att: 0, dInf: 20, dCav: 10, cav: true, carry: 0, cost: 380, use: false, speed: 19, upkeep: 2 }, // Spotter
    u64: { att: 120, dInf: 30, dCav: 15, cav: true, carry: 75, cost: 895, use: true, speed: 16, upkeep: 2 }, // Steppe Rider
    u65: { att: 110, dInf: 80, dCav: 70, cav: true, carry: 105, cost: 1050, use: true, speed: 15, upkeep: 2 }, // Marksman
    u66: { att: 180, dInf: 60, dCav: 40, cav: true, carry: 80, cost: 1760, use: true, speed: 14, upkeep: 3 }, // Marauder
    u67: { att: 65, dInf: 30, dCav: 90, cav: false, carry: 0, cost: 1820, use: false, speed: 4, upkeep: 3 }, // Ram
    u68: { att: 45, dInf: 55, dCav: 10, cav: false, carry: 0, cost: 2910, use: false, speed: 3, upkeep: 6 }, // Catapult
    u69: { att: 50, dInf: 40, dCav: 30, cav: false, carry: 0, cost: 117600, use: false, speed: 5, upkeep: 4 }, // Logades
    u70: { att: 0, dInf: 80, dCav: 80, cav: false, carry: 3000, cost: 20900, use: false, speed: 5, upkeep: 1 }, // Settler
  };

  // Nature (oasis animals): att, dInf, dCav, upkeep (crop per hour).
  const ANIMALS = {
    u31: { dInf: 25, dCav: 20, upkeep: 1 }, // Rat
    u32: { dInf: 35, dCav: 40, upkeep: 1 }, // Spider
    u33: { dInf: 40, dCav: 60, upkeep: 1 }, // Snake
    u34: { dInf: 66, dCav: 50, upkeep: 1 }, // Bat
    u35: { dInf: 70, dCav: 33, upkeep: 2 }, // Wild Boar
    u36: { dInf: 80, dCav: 70, upkeep: 2 }, // Wolf
    u37: { dInf: 140, dCav: 200, upkeep: 3 }, // Bear
    u38: { dInf: 380, dCav: 240, upkeep: 3 }, // Crocodile
    u39: { dInf: 170, dCav: 250, upkeep: 3 }, // Tiger
    u40: { dInf: 440, dCav: 520, upkeep: 5 }, // Elephant
  };

  // English names, for when the game's data has none (e.g. tooltip replies).
  const NAMES = {
    u31: 'Rat', u32: 'Spider', u33: 'Snake', u34: 'Bat', u35: 'Wild Boar',
    u36: 'Wolf', u37: 'Bear', u38: 'Crocodile', u39: 'Tiger', u40: 'Elephant',
    u61: 'Mercenary', u62: 'Bowman', u63: 'Spotter', u64: 'Steppe Rider', u65: 'Marksman',
    u66: 'Marauder', u67: 'Ram', u68: 'Catapult', u69: 'Logades', u70: 'Settler',
  };

  // Smithy levels ({uNN: level}) and alliance attack bonus (e.g. 1.02),
  // read from the rally point combat simulator by content.js.
  let bonus = { levels: {}, alliance: 1 };
  function setBonus(b) {
    bonus = { levels: (b && b.levels) || {}, alliance: (b && b.alliance) || 1 };
  }

  // Attack of one unit with its smithy upgrade:
  // base + (base + 300 * upkeep / 7) * (1.007^level - 1).
  function attack(unit) {
    const u = UNITS[unit];
    const level = bonus.levels[unit] || 0;
    return (u.att + (u.att + (300 * u.upkeep) / 7) * (Math.pow(1.007, level) - 1)) * bonus.alliance;
  }

  // Killing an animal adds this many of each resource per point of its upkeep
  // to the hero's inventory (report: 4 boars, 3 wolves, 3 bears = 23 -> 920).
  const KILL_BONUS_PER_UPKEEP = 40;

  // Smallest raid on an oasis, per kind of army: infantry (Mercenary, Bowman)
  // and cavalry (Steppe Rider, Marksman, Marauder) each go as one group of
  // mixed types, never together. A group with fewer at home is not sent.
  const RAID_MIN = { inf: 50, cav: 30 };
  const kindOf = (cav) => (cav ? 'cav' : 'inf');

  // Every defender gets a base defence of 10 (also in oases).
  const BASE_DEFENCE = 10;

  // Order to fill an army: cavalry first, then infantry, strongest attack
  // first. With cheapCav, cavalry is ordered cheapest first instead.
  // With only, use just that unit type.
  function priority(own, cheapCav, only) {
    return own
      .filter((t) => UNITS[t.unit] && UNITS[t.unit].use && UNITS[t.unit].att > 0 && t.count > 0)
      .filter((t) => !only || t.unit === only)
      .sort((a, b) => {
        const ua = UNITS[a.unit], ub = UNITS[b.unit];
        if (ua.cav !== ub.cav) return ua.cav ? -1 : 1;
        if (cheapCav && ua.cav) return ua.cost - ub.cost;
        return ub.att - ua.att;
      });
  }

  // Raid (unoccupied oases only allow raids). Returns
  // {win, deaths: {unit: n}, totalDeaths, lostRes, carry, animalsKilled}.
  function simulate(army, animals) {
    let aInf = 0, aCav = 0, attackers = 0;
    for (const [unit, n] of Object.entries(army)) {
      const u = UNITS[unit];
      (u.cav ? (aCav += n * attack(unit)) : (aInf += n * attack(unit)));
      attackers += n;
    }
    const a = aInf + aCav;
    let dInf = 0, dCav = 0, defenders = 0;
    for (const t of animals) {
      const s = ANIMALS[t.unit];
      if (!s) continue;
      dInf += t.count * s.dInf;
      dCav += t.count * s.dCav;
      defenders += t.count;
    }
    const d = (a > 0 ? (dInf * aInf + dCav * aCav) / a : dInf) + (defenders > 0 ? BASE_DEFENCE : 0);

    // Mass factor: 1.5 for normal-sized fights, lower for huge ones.
    const n = attackers + defenders;
    const k = Math.min(1.5, Math.max(1.2578, 2 * (1.8592 - Math.pow(n, 0.015))));
    const win = a > d;
    // Raid: x = (loser / winner)^k; winner loses x/(1+x), loser 1/(1+x).
    let attLoss = 0, defLoss = 0;
    if (defenders > 0) {
      const x = win ? Math.pow(d / a, k) : Math.pow(a / d, k);
      attLoss = win ? x / (1 + x) : 1 / (1 + x);
      defLoss = win ? 1 / (1 + x) : x / (1 + x);
    }

    // Round the TOTAL expected losses, then hand them out to the unit types
    // (largest share first). Rounding each type alone would let a split army
    // hide losses: 21 x 3% and 18 x 3% both round to 0, together it is ~1.2.
    const entries = Object.entries(army);
    const share = entries.map(([, cnt]) => cnt * attLoss);
    const totalDeaths = Math.min(attackers, Math.round(share.reduce((s, x) => s + x, 0)));
    const dead = share.map(Math.floor);
    let left = totalDeaths - dead.reduce((s, x) => s + x, 0);
    const byRemainder = share.map((x, i) => [x - Math.floor(x), i]).sort((p, q) => q[0] - p[0]);
    for (const [, i] of byRemainder) {
      if (left <= 0) break;
      if (dead[i] < entries[i][1]) {
        dead[i]++;
        left--;
      }
    }
    const deaths = {};
    let lostRes = 0, carry = 0, animalsKilled = 0;
    entries.forEach(([unit, cnt], i) => {
      deaths[unit] = dead[i];
      lostRes += dead[i] * UNITS[unit].cost;
      carry += (cnt - dead[i]) * UNITS[unit].carry;
    });
    let killBonus = 0;
    for (const t of animals) {
      const killed = Math.round(t.count * defLoss);
      animalsKilled += killed;
      if (ANIMALS[t.unit]) killBonus += killed * ANIMALS[t.unit].upkeep * KILL_BONUS_PER_UPKEEP * 4;
    }
    // Gain: the hero kill bonus only. The loot is unknown (the oasis may hold
    // far less than the troops can carry), so it is left out.
    const gain = killBonus;
    return { win: win || defenders === 0, deaths, totalDeaths, lostRes, carry, animalsKilled, killBonus, gain };
  }

  // Army of `total` units taken from the priority list in order.
  function fill(order, total) {
    const army = {};
    for (const t of order) {
      if (total <= 0) break;
      const take = Math.min(total, t.count);
      army[t.unit] = take;
      total -= take;
    }
    return army;
  }

  // Smallest army (by unit count) with at most `maxDeaths` losses.
  // opts.cheapCav: use the cheapest cavalry first.
  // opts.padBelow / opts.padPct: if fewer than padBelow units are needed,
  //   send padPct more as a safety margin.
  // opts.minTotal: send at least this many units (never fewer than RAID_MIN).
  // opts.minByKind: {cav, inf}: like minTotal, per kind of army.
  // opts.maxLossRatio: instead of a death limit, lose at most this share of
  //   the gain in resources (pass maxDeaths = Infinity).
  // opts.only: use only this unit type (e.g. 'u62').
  // Cavalry and infantry are never mixed: the army is cavalry only, or, when
  // cavalry cannot do it, infantry only.
  function findArmy(own, animals, maxDeaths, opts = {}) {
    const ok = (r) => r.win && r.totalDeaths <= maxDeaths &&
      (opts.maxLossRatio == null || r.lostRes <= opts.maxLossRatio * r.gain);
    const order = priority(own, opts.cheapCav, opts.only);
    for (const cav of [true, false]) {
      const group = order.filter((t) => UNITS[t.unit].cav === cav);
      const kind = kindOf(cav);
      const minTotal = Math.max(opts.minTotal || 0, (opts.minByKind && opts.minByKind[kind]) || 0, RAID_MIN[kind]);
      const plan = search(group, animals, ok, { ...opts, minTotal });
      if (plan) return plan;
    }
    return null;
  }

  // Smallest army from one group (in priority order) that passes ok().
  function search(order, animals, ok, opts) {
    const available = order.reduce((s, t) => s + t.count, 0);
    if (opts.minTotal && available < opts.minTotal) return null;
    for (let total = 1; total <= available; total++) {
      const army = fill(order, total);
      const r = simulate(army, animals);
      if (!ok(r)) continue;
      let padded = total;
      if (opts.padBelow && total < opts.padBelow) padded = Math.ceil(total * (1 + opts.padPct));
      if (opts.minTotal) padded = Math.max(padded, opts.minTotal);
      padded = Math.min(padded, available);
      if (padded > total) {
        const bigArmy = fill(order, padded);
        const big = simulate(bigArmy, animals);
        // Extra units can spill into another unit type of the group; keep
        // them only if the bigger army still stays within the loss limit.
        if (ok(big)) {
          return { army: bigArmy, total: padded, needed: total, ...big };
        }
        if (opts.minTotal && total < opts.minTotal) {
          // The minimum army spilled into weaker types and fails: the
          // smallest bigger one that passes.
          for (let more = padded + 1; more <= available; more++) {
            const a = fill(order, more);
            const m = simulate(a, animals);
            if (ok(m)) return { army: a, total: more, needed: total, ...m };
          }
          return null;
        }
      }
      return { army, total, needed: total, ...r };
    }
    return null;
  }

  // When no plan meets the limit: the whole cavalry or the whole infantry
  // (whichever loses the smaller share of the gain), to show what is possible.
  function bestEffort(own, animals, opts = {}) {
    const order = priority(own, opts.cheapCav, opts.only);
    let best = null;
    for (const cav of [true, false]) {
      const group = order.filter((t) => UNITS[t.unit].cav === cav);
      const total = group.reduce((s, t) => s + t.count, 0);
      if (!group.length || total < RAID_MIN[kindOf(cav)]) continue;
      const army = fill(group, total);
      const r = { army, total, needed: total, best: true, ...simulate(army, animals) };
      const share = (p) => (p.win ? p.lostRes / Math.max(1, p.gain) : Infinity);
      if (!best || share(r) < share(best)) best = r;
    }
    return best;
  }

  // Exactly `total` units of one group (cav: true = horses, false = infantry),
  // cheapest horses / strongest infantry first, as far as there are any.
  // tooFew: below RAID_MIN, not to be sent.
  function customArmy(own, animals, total, cav) {
    const group = priority(own, true).filter((t) => UNITS[t.unit].cav === cav);
    const available = group.reduce((s, t) => s + t.count, 0);
    const n = Math.min(total, available);
    if (n <= 0) return null;
    const army = fill(group, n);
    return { army, total: n, needed: n, tooFew: n < RAID_MIN[kindOf(cav)], ...simulate(army, animals) };
  }

  window.OasisBattle = {
    UNITS, ANIMALS, NAMES, RAID_MIN, simulate, findArmy, bestEffort, customArmy, setBonus, getBonus: () => bonus,
  };
})();
