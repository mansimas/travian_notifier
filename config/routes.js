module.exports.routes = {
  'GET /status': 'StatusController.status',
  'GET /oases': 'OasisController.stage',
  'GET /autoraid': 'OasisController.autoraid',
  'GET /villages': 'OasisController.villages',
  'GET /activity': 'OasisController.activity',
  'GET /mute': 'StatusController.mute',
  'POST /mute': 'StatusController.mute',
  'GET /unmute': 'StatusController.unmute',
  'GET /stop': 'StatusController.stopRaids',
  'POST /stop': 'StatusController.stopRaids',
  'GET /start': 'StatusController.startRaids',
  'POST /start': 'StatusController.startRaids',
  'GET /stop_cav': 'StatusController.stopCav',
  'POST /stop_cav': 'StatusController.stopCav',
  'GET /start_cav': 'StatusController.startCav',
  'POST /start_cav': 'StatusController.startCav',
  'POST /unmute': 'StatusController.unmute',
};
// /stop2, /stop2cav, /stop2inf, /start2, ... per village mansim1-3 (StatusController.village).
for (const n of [1, 2, 3]) {
  for (const verb of ['stop', 'start']) {
    for (const kind of ['', 'cav', 'inf']) {
      module.exports.routes['GET /' + verb + n + kind] = 'StatusController.village';
      module.exports.routes['POST /' + verb + n + kind] = 'StatusController.village';
    }
  }
}
