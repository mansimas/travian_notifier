/**
 * One-off commands, run on the server next to the live app:
 *   npm run check       log in once, print the villages and attacks it sees, save dorf1.html
 *   npm run test-call   ring the phone once
 *   npm run test-alarm  the full alarm: several calls, as an attack rings it
 * Loads sails without the http server, so it does not clash with the running app.
 */
process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config();
const fs = require('fs');
const rc = require('sails/accessible/rc')('sails');
rc.hooks = { ...rc.hooks, http: false };
rc.log = { level: 'warn', noShip: true };
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
