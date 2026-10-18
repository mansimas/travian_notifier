/**
 * Bootstrap
 *
 * Starts the attack watcher on the master process once the app is lifted.
 */
module.exports.bootstrap = function (cb) {
  sails.on('lifted', function () {
    const master = process.argv.slice(2)[0] === 'master' || process.env.NODE_ENV !== 'production';
    if (master && sails.config.travian.watch) {
      sails.log.info('lifted on master, watching for attacks');
      NotifierService.start();
    } else {
      sails.log.info('lifted, watcher off');
    }
  });
  cb();
};
