module.exports.routes = {
  'GET /status': 'StatusController.status',
  'GET /oases': 'OasisController.stage',
  'GET /autoraid': 'OasisController.autoraid',
  'GET /mute': 'StatusController.mute',
  'POST /mute': 'StatusController.mute',
  'GET /unmute': 'StatusController.unmute',
  'POST /unmute': 'StatusController.unmute',
};
