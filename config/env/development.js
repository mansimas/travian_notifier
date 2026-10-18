module.exports = {
  // Locally the watcher only runs when asked: `WATCH=1 node app.js`, so a dev lift never logs in
  // to Travian next to the server.
  travian: { watch: !!process.env.WATCH },
};
