/**
 * OasisController
 *
 * GET /oases?stage=1&village=mansim2&fresh=1   animals of one oasis stage (OasisService.stage),
 * as JSON. Only from this machine, like /status: `curl -s 'localhost:1421/oases?stage=1'`.
 * GET /autoraid   what the auto raids did (AutoRaidService.status), also loopback only.
 * GET /villages?status=inactive   active/slow/inactive villages and players around us
 * (VillageWatchService.analysis), also loopback only.
 */
module.exports = {
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
