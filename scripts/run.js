/**
 * One-off commands, run on the server next to the live app:
 *   npm run check       log in once, print the villages and attacks it sees, save dorf1.html
 *   npm run test-call   ring the phone once
 *   npm run test-alarm  the full alarm: several calls, as an attack rings it
 *   npm run oases -- [stage] [village] [fresh]
 *                       animals of one oasis stage (1 = closest), saves .tmp/oases-<x>_<y>.json
 *   npm run troops      every troop of every village: home, outgoing, returning, reinforcing
 *   npm run autoraid    one auto raid round now (AUTO_RAID_SEND=0 for a dry run)
 *   npm run villages -- [snap] [status]
 *                       active/inactive villages around us from .tmp/villagewatch.json;
 *                       snap: take a snapshot first
 *   npm run reports-backfill
 *                       every oasis raid report still in the game into .tmp/report-history.json,
 *                       slowly (one request every 3-6 s); run it again to go on
 * Loads sails without the http server, so it does not clash with the running app.
 */
process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config();
const fs = require('fs');
const rc = require('sails/accessible/rc')('sails');
rc.hooks = { ...rc.hooks, http: false };
rc.log = { level: process.argv[2] === 'reports-backfill' ? 'info' : 'warn', noShip: true }; // backfill logs its progress
rc.travian = { watch: false };

const commands = {
  check: async function () {
    const { html, villages, active, movements } = await TravianService.read();
    fs.writeFileSync('dorf1.html', html);
    console.log('active village:', active);
    console.log('villages:');
    for (const v of villages) console.log('  ' + v.name + ' (' + v.id + '): ' + v.attacks + ' incoming attacks');
    console.log('incoming attacks on active village:', movements || 'none');
    console.log('page saved to dorf1.html');
  },
  'test-call': async function () {
    console.log('CallMeBot: ' + await PhoneService.call('Travian alarm test. Your notifier can wake you up.'));
  },
  // The full alarm as an attack would ring it: CALL_COUNT calls, CALL_GAP_SECONDS apart.
  'test-alarm': async function () {
    await PhoneService.alarm('Travian alarm test. Your village is under attack. Wake up.');
    console.log('alarm done');
  },
  troops: async function () {
    const { total, byVillage, byState, byVillageState, pages } = await TroopsService.count();
    const line = units => Object.entries(units).sort().map(([u, n]) => u + ' ' + n).join(', ') || 'none';
    console.log('TOTAL: ' + line(total));
    console.log('by village:');
    for (const [v, units] of Object.entries(byVillage)) {
      console.log('  ' + v + ' (' + pages[v] + ' pages): ' + line(units));
      for (const [s, u] of Object.entries(byVillageState[v])) console.log('    ' + s + ': ' + line(u));
    }
    console.log('by state:');
    for (const [s, units] of Object.entries(byState)) console.log('  ' + s + ': ' + line(units));
  },
  autoraid: async function () {
    const log = await AutoRaidService.round();
    console.log(JSON.stringify(log, null, 1));
  },
  // npm run report -- <id>: one report as plain text (id as kept, e.g. 250912476|90b955f8).
  report: async function () {
    const id = process.argv[3];
    let res = await TravianService.request('GET', '/report?id=' + encodeURIComponent(id));
    if (!TravianService.loggedIn(res.body)) {
      await TravianService.login();
      res = await TravianService.request('GET', '/report?id=' + encodeURIComponent(id));
    }
    const html = res.body.slice(res.body.indexOf('id="reportWrapper"'));
    console.log(html.slice(0, 60000).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').slice(0, 3000));
  },
  // npm run tile -- <x> <y>: the map tile details (owner, population, troops) as plain text.
  tile: async function () {
    const [x, y] = process.argv.slice(3).map(Number);
    const data = await OasisService.api('map/tile-details', { x, y });
    const html = typeof data === 'string' ? data : (data && data.html) || '';
    console.log(html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[\u202a-\u202e\u200e\u200f]/g, '').replace(/\s+/g, ' ').slice(0, 1500));
  },
  villages: async function () {
    const args = process.argv.slice(3);
    if (args.includes('snap')) console.log('snapshot: ' + JSON.stringify(await VillageWatchService.snapshot()));
    const a = VillageWatchService.analysis({ status: args.find(s => s !== 'snap') });
    console.log(a.snaps + ' snapshots ' + a.from + ' - ' + a.to + ', ' + JSON.stringify(a.counts));
    for (const p of a.players) {
      console.log('  ' + p.status.padEnd(8) + ' ' + p.player + (p.alliance ? ' [' + p.alliance + ']' : '') + ' pop ' + p.pop
        + ' +' + p.gained24h + '/24h +' + p.gained72h + '/72h, last growth ' + (p.lastGrowth || '-') + ', ' + p.villages.join(' '));
    }
  },
  'reports-backfill': async function () {
    console.log(JSON.stringify(await AutoRaidService.backfillReports()));
  },
  oases: async function () {
    const args = process.argv.slice(3);
    const fresh = args.includes('fresh');
    const [stage = 1, village] = args.filter(a => a !== 'fresh');
    const { scan, animals } = await OasisService.stage({ stage, village, fresh });
    console.log(scan.village.name + ' (' + scan.village.x + '|' + scan.village.y + '): ' + scan.counts.free + ' free / '
      + scan.counts.occupied + ' taken oases within ' + scan.radius + ', scanned ' + scan.scanned);
    console.log('stage ' + animals.stage + ': ' + animals.source + ', ' + animals.seconds.toFixed(1) + ' s');
    if (animals.skipped.length) console.log('  skipped, taken now or before: ' + animals.skipped.map(o => '(' + o.x + '|' + o.y + ')' + (o.owner ? ' ' + o.owner : '')).join(', '));
    for (const c of animals.checks) console.log('  check (' + c.x + '|' + c.y + '): ' + (c.same ? 'same' : 'DIFFERENT ' + JSON.stringify(c)));
    for (const o of animals.oases) {
      const list = o.animals.map(a => a.unit + ' ' + a.count).join(', ');
      console.log('  (' + o.x + '|' + o.y + ') ' + o.distance.toFixed(1) + '  ' + (list || 'empty'));
    }
  },
};

const command = commands[process.argv[2]];
if (!command) {
  console.error('usage: node scripts/run.js ' + Object.keys(commands).join('|'));
  process.exit(1);
}
require('sails').load(rc, function (err) {
  if (err) { console.error(err); process.exit(1); }
  command().then(() => process.exit(0), e => { console.error(e.message); process.exit(1); });
});
