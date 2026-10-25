/**
 * OasisController
 *
 * GET /oases?stage=1&village=mansim2&fresh=1   animals of one oasis stage (OasisService.stage),
 * as JSON. Only from this machine, like /status: `curl -s 'localhost:1421/oases?stage=1'`.
 * GET /autoraid   what the auto raids did (AutoRaidService.status), also loopback only.
 * GET /villages?status=inactive   active/slow/inactive villages and players around us
 * (VillageWatchService.analysis), also loopback only.
 * GET /activity   per watched village the hours since its player last grew, for the oasis-dot
 * plugin's map labels. Public as https://avogames.com/activity (nginx), no key, CORS for travian.com.
 */
const TRAVIAN_ORIGIN = /^https:\/\/[a-z0-9.-]+\.travian\.com$/;

module.exports = {
  activity: function (req, res) {
    const origin = req.headers.origin;
    if (origin && TRAVIAN_ORIGIN.test(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    return res.json(VillageWatchService.activity());
  },

  villages: function (req, res) {
    if (req.headers['x-forwarded-for']) return res.forbidden(); // came through nginx
    return res.json(VillageWatchService.analysis({ status: req.query.status }));
  },

  autoraid: function (req, res) {
    if (req.headers['x-forwarded-for']) return res.forbidden(); // came through nginx
    return res.json(AutoRaidService.status());
  },

  stage: async function (req, res) {
    if (req.headers['x-forwarded-for']) return res.forbidden(); // came through nginx
    try {
      return res.json(await OasisService.stage({ stage: req.query.stage || 1, village: req.query.village, fresh: !!req.query.fresh }));
    } catch (e) {
      sails.log.error('oases: ' + e.message);
      return res.status(500).json({ error: e.message });
    }
  },
};
