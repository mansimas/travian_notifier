/**
 * OasisController
 *
 * GET /oases?stage=1&village=mansim2&fresh=1   animals of one oasis stage (OasisService.stage),
 * as JSON. Only from this machine, like /status: `curl -s 'localhost:1421/oases?stage=1'`.
 */
module.exports = {
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
