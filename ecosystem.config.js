// pm2 start ecosystem.config.js
// Its own app name, so the games' `pm2 reload <name>` deploys never touch it.
module.exports = {
  apps: [{
    name: 'TravianNotifier',
    script: 'notifier.js',
    log_date_format: 'YYYY-MM-DD HH:mm Z',
    autorestart: true,
    restart_delay: 60 * 1000,
    max_memory_restart: '200M',
  }],
};
