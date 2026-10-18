/**
 * StatusController
 *
 * GET /status         what the watcher last saw. Only from this machine: `curl localhost:1421/status`.
 * GET|POST /mute      start the quiet time now: no call for ?h= hours (default callCooldownHours,
 *                     at most MAX_MUTE_HOURS).
 * GET|POST /unmute    end the quiet time, so the next new attack rings again.
 * Both public as https://avogames.com/mute and /unmute (nginx), no key - asked for that way.
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

  unmute: function (req, res) {
    NotifierService.unmute();
    if (req.method === 'POST') return res.json({ ok: true });
    return page(res, 'Alarms are on again. The next new attack rings.');
  },
};
