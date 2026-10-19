module.exports.routes = {
  'GET /status': 'StatusController.status',
  'GET /oases': 'OasisController.stage',
  'GET /autoraid': 'OasisController.autoraid',
  'GET /mute': 'StatusController.mute',
  'POST /mute': 'StatusController.mute',
  'GET /unmute': 'StatusController.unmute',
  'GET /stop': 'StatusController.stopRaids',
  'POST /stop': 'StatusController.stopRaids',
  'GET /start': 'StatusController.startRaids',
  'POST /start': 'StatusController.startRaids',
  'POST /unmute': 'StatusController.unmute',
};
