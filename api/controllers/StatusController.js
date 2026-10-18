/**
 * StatusController
 *
 * GET /status         what the watcher last saw. Only from this machine: `curl localhost:1421/status`.
 * GET|POST /unmute    end the quiet time after an alarm, so the next new attack rings again.
 *                     Public as https://avogames.com/unmute (nginx); the worst a stranger can do
 *                     with it is turn the alarms back on, so it has no key.
 */
module.exports = {
  status: function (req, res) {
    if (req.headers['x-forwarded-for']) return res.forbidden(); // came through nginx
    return res.json(NotifierService.status());
  },

  unmute: function (req, res) {
    NotifierService.unmute();
    if (req.method === 'POST') return res.json({ ok: true });
    return res.send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<body style="font:20px sans-serif;padding:24px">Alarms are on again. The next new attack rings.</body>');
  },
};
