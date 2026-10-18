/**
 * app.js
 *
 * `node app.js master` (pm2 runs this, see ecosystem.config.js). Only the master process runs the
 * attack watcher, see config/bootstrap.js.
 */
process.chdir(__dirname);
require('dotenv').config();
const sails = require('sails');
const rc = require('sails/accessible/rc');
sails.lift(rc('sails'));
