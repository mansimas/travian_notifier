/**
 * NotifierService
 *
 * The watch loop: every few minutes TravianService.read(), and one phone call when any village
 * has more incoming attacks than at the last check - unless the last alarm was less than
 * callCooldownHours ago, then the attack is only logged. What the last check saw and when the
 * last alarm rang are kept in .tmp/state.json, so a restart does not ring again.
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

// Names of the villages with more incoming attacks than at the last check.
function newAttacks(before, villages) {
  const counts = before.counts || {};
  return villages.filter(v => v.attacks > (counts[v.id] || 0)).map(v => v.name);
}

async function check() {
  const { villages, active, movements } = await TravianService.read();
  const fresh = newAttacks(state, villages);
  if (fresh.length) {
    let text = 'Travian alarm. ' + fresh.join(', ') + ' under attack.';
    if (movements && movements.inSeconds != null && fresh.includes(active)) {
      text += ' First attack on ' + active + ' arrives in ' + Math.round(movements.inSeconds / 60) + ' minutes.';
    }
    const quietUntil = (state.alarmAt || 0) + sails.config.travian.callCooldownHours * 60 * 60 * 1000;
    if (Date.now() < quietUntil) {
      sails.log.warn(text + ' (no call, quiet until ' + new Date(quietUntil).toISOString() + ')');
    } else {
      sails.log.warn(text);
      // A call that does not go through must still reach the phone somehow: as a text.
      await PhoneService.alarm(text).catch(e => {
        sails.log.error(e.message);
        return PhoneService.message(text + ' (The call failed: ' + e.message + ')');
      });
      state.alarmAt = Date.now();
    }
  }
  state.counts = Object.fromEntries(villages.map(v => [v.id, v.attacks]));
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

  // Ends the quiet time after an alarm now, so the next new attack rings again.
  unmute: function () {
    delete state.alarmAt;
    writeState();
    sails.log.info('travian notifier: unmuted');
  },

  status: function () {
    return {
      lastCheck,
      alarmAt: state.alarmAt ? new Date(state.alarmAt).toISOString() : null,
      quietUntil: state.alarmAt ? new Date(state.alarmAt + sails.config.travian.callCooldownHours * 60 * 60 * 1000).toISOString() : null,
      problemSentAt: state.problemSentAt || null,
    };
  },

  newAttacks,
};
