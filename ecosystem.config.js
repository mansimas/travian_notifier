module.exports = {
  "apps" : [
    {
      "name": "TravianNotifier",
      "script": "app.js",
      "log_date_format": "YYYY-MM-DD HH:mm Z",
      "args": ["master"],
      "exec_mode": "fork",
      "instances": 1,
      "autorestart": true,
      "watch": false,
      "max_memory_restart": "300M",
      env: {
        NODE_ENV: 'production'
      },
    }
  ]
};
