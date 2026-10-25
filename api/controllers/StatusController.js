/**
 * StatusController
 *
 * GET /status         what the watcher last saw. Only from this machine: `curl localhost:1421/status`.
 * GET|POST /mute      start the quiet time now: no call for ?h= hours (default callCooldownHours,
 *                     at most MAX_MUTE_HOURS).
 * GET|POST /unmute    end the quiet time, so the next new attack rings again.
 * GET|POST /stop     no more auto raids (AutoRaidService) until /start.
 * GET|POST /start    auto raids go on (also ends /stop_cav).
 * GET|POST /stop_cav  no more horse raids until /start_cav or /start; infantry and Mercenaries go on.
 * GET|POST /start_cav horse raids go on.
 * GET|POST /stop2     village mansim2 sends nothing until /start2 (or /start); /stop2cav only its horses,
 *                     /stop2inf only its infantry. Same for 1 and 3. /start2cav, /start2inf undo one kind.
 * All public as https://avogames.com/mute, /unmute, /stop, /start, /stop_cav, /start_cav, /stopN... (nginx), no key - asked
 * for that way.
 * Answered with a small page, as they are opened from the phone's browser.
 */

const MAX_MUTE_HOURS = 14 * 24;

function page(res, text) {
  return res.send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<body style="font:20px sans-serif;padding:24px">' + text + '</body>');
}
module.exports = {
  status: function (req, res) {
    if (req.headers['x-forwarded-for']) return res.forbidden(); // came through nginx
    return res.json(NotifierService.status());
  },

  mute: function (req, res) {
    const h = Number(req.query.h || req.body && req.body.h);
    const hours = h > 0 ? Math.min(h, MAX_MUTE_HOURS) : sails.config.travian.callCooldownHours;
    NotifierService.mute(hours);
    const until = NotifierService.status().quietUntil;
    if (req.method === 'POST') return res.json({ ok: true, quietUntil: until });
    const local = new Date(until).toLocaleString('en-GB', { timeZone: sails.config.travian.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return page(res, 'Alarms are off until ' + local + '.');
  },

  stopRaids: function (req, res) {
    AutoRaidService.stop();
    if (req.method === 'POST') return res.json({ ok: true, stopped: true });
    return page(res, 'Auto raids are stopped. Open /start to go on.');
  },

  startRaids: function (req, res) {
    AutoRaidService.resume();
    if (req.method === 'POST') return res.json({ ok: true, stopped: false });
    return page(res, 'Auto raids are on again.');
  },

  stopCav: function (req, res) {
    AutoRaidService.stopCav();
    if (req.method === 'POST') return res.json({ ok: true, cavStopped: true });
    return page(res, 'Horse raids are stopped, infantry and Mercenaries go on. Open /start_cav to send horses again.');
  },

  startCav: function (req, res) {
    AutoRaidService.resumeCav();
    if (req.method === 'POST') return res.json({ ok: true, cavStopped: false });
    return page(res, 'Horse raids are on again.');
  },

  // /stop2, /stop2cav, /stop2inf, /start2, /start2cav, /start2inf (config/routes.js, villages 1-3).
  village: function (req, res) {
    const m = req.path.match(/^\/(stop|start)(\d)(cav|inf)?$/);
    if (!m) return res.notFound();
    const name = 'mansim' + m[2];
    const kinds = m[3] ? [m[3]] : ['cav', 'inf'];
    const vs = AutoRaidService.stopVillage(name, kinds, m[1] === 'stop');
    if (req.method === 'POST') return res.json({ ok: true, village: name, stopped: vs });
    const what = { cav: 'horses', inf: 'infantry' };
    const stopped = Object.keys(vs).map(k => what[k]);
    return page(res, name + ': ' + (stopped.length ? stopped.join(' and ') + ' stay at home. Open /start' + m[2] + ' to send again.'
      : 'raids are on again.'));
  },

  unmute: function (req, res) {
    NotifierService.unmute();
    if (req.method === 'POST') return res.json({ ok: true });
    return page(res, 'Alarms are on again. The next new attack rings.');
  },
};
