// Loopback only: the status page is for `curl localhost:1421/status` on the server, it is not
// behind nginx and nothing outside the machine should reach it.
module.exports.port = 1421;
module.exports.explicitHost = '127.0.0.1';
