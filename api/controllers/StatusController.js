/**
 * StatusController
 *
 * GET /status         what the watcher last saw.
 * GET|POST /unmute    end the quiet time after an alarm, so the next new attack rings again.
 *
 * On the server itself (`curl localhost:1421/status`) no key is needed. Through nginx
 * (https://avogames.com/travian/... - nginx adds X-Forwarded-For) every request needs
 * ?key=<UNMUTE_KEY from .env>, and without UNMUTE_KEY set nothing is reachable from outside.
 * /unmute answers with a small page, as it is opened from the phone's browser.
 */
const crypto = require('crypto');

function allowed(req) {
  if (!req.headers['x-forwarded-for']) return true; // not through nginx: from this machine
  const key = sails.config.travian.unmuteKey;
  const given = String(req.query.key || '');
  return !!key && given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
}

module.exports = {
  status: function (req, res) {
    if (!allowed(req)) return res.forbidden();
    return res.json(NotifierService.status());
  },

  unmute: function (req, res) {
    if (!allowed(req)) return res.forbidden();
    NotifierService.unmute();
    if (req.method === 'POST') return res.json(NotifierService.status());
    return res.send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<body style="font:20px sans-serif;padding:24px">Alarms are on again. The next new attack rings.</body>');
  },
};
