/**
 * NotifierService
 *
 * The watch loop: every few minutes TravianService.read(), and one phone call per NEW attack.
 * A new attack is a village that was not under attack at the last check, or more attacks on the
 * active village than last time. What the last check saw is kept in .tmp/state.json, so a
 * restart does not ring again for an attack already called.
 *
 * When checks keep failing (login refused, page changed) the player gets one Telegram text -
 * never a call, a broken notifier must not wake anybody.
 */
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(process.cwd(), '.tmp', 'state.json');

let state = {};
let lastCheck = null; // { at, ok, error?, villages?, active?, movements? } for /status

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}

function writeState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function newAttacks(before, villages, active, movements) {
  const attacked = new Set(before.attacked || []);
  const fresh = villages.filter(v => v.attacked && !attacked.has(v.id)).map(v => v.name);
  const count = movements ? movements.count : 0;
  if (active && count > ((before.activeCounts || {})[active] || 0) && !fresh.includes(active)) fresh.push(active);
  return fresh;
}

async function check() {
  const { villages, active, movements } = await TravianService.read();
  const fresh = newAttacks(state, villages, active, movements);
  if (fresh.length) {
    let text = 'Travian alarm. ' + fresh.join(', ') + ' under attack.';
    if (movements && movements.inSeconds != null && fresh.includes(active)) {
      text += ' First attack on ' + active + ' arrives in ' + Math.round(movements.inSeconds / 60) + ' minutes.';
    }
    sails.log.warn(text);
    await PhoneService.call(text);
  }
  state.attacked = villages.filter(v => v.attacked).map(v => v.id);
  state.activeCounts = active ? { [active]: movements ? movements.count : 0 } : {};
  writeState();
  lastCheck = { at: new Date().toISOString(), ok: true, villages, active, movements };
}

async function loop() {
  const cfg = sails.config.travian;
  const minute = 60 * 1000;
  let fails = 0;
  let pause = cfg.errorPauseMinutes * minute;
  for (;;) {
    let wait = (cfg.pollMinutes + Math.random() * cfg.pollJitterMinutes) * minute;
    try {
      await check();
      fails = 0;
      pause = cfg.errorPauseMinutes * minute;
    } catch (e) {
      fails++;
      sails.log.error('travian check failed (' + fails + '): ' + e.message);
      lastCheck = { at: new Date().toISOString(), ok: false, error: e.message, fails };
      wait = pause;
      pause = Math.min(pause * 2, cfg.errorPauseMaxMinutes * minute);
      if (fails >= cfg.problemAfterFails && Date.now() - (state.problemSentAt || 0) > cfg.problemRepeatHours * 60 * minute) {
        state.problemSentAt = Date.now();
        writeState();
        await PhoneService.message('Travian notifier is NOT watching your villages: ' + e.message)
          .catch(err => sails.log.error('problem text failed: ' + err.message));
      }
    }
    await new Promise(r => setTimeout(r, wait));
  }
}

module.exports = {
  start: function () {
    const missing = ['server', 'username', 'password', 'telegramUser'].filter(k => !sails.config.travian[k]);
    if (missing.length) {
      sails.log.error('travian notifier NOT started, missing in .env: ' + missing.join(', ') + ' (see .env.example)');
      lastCheck = { at: new Date().toISOString(), ok: false, error: 'missing in .env: ' + missing.join(', ') };
      return;
    }
    state = readState();
    sails.log.info('travian notifier: watching ' + sails.config.travian.server + ' as ' + sails.config.travian.username);
    loop();
  },

  status: function () {
    return { lastCheck, attacked: state.attacked || [], problemSentAt: state.problemSentAt || null };
  },

  newAttacks,
};
