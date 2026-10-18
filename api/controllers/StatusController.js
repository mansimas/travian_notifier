/**
 * StatusController
 *
 * GET /status - what the watcher last saw, for `curl localhost:1421/status` on the server.
 * POST /unmute - end the quiet time after an alarm: `curl -X POST localhost:1421/unmute`.
 */
module.exports = {
  status: function (req, res) {
    return res.json(NotifierService.status());
  },

  unmute: function (req, res) {
    NotifierService.unmute();
    return res.json(NotifierService.status());
  },
};
