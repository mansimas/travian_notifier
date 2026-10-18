/**
 * StatusController
 *
 * GET /status - what the watcher last saw, for `curl localhost:1421/status` on the server.
 */
module.exports = {
  status: function (req, res) {
    return res.json(NotifierService.status());
  },
};
