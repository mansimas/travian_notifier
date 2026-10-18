/**
 * PhoneService
 *
 * Reaches the player's iPhone through CallMeBot (free): a Telegram voice call that reads the
 * text out (rings through Sleep Focus once Telegram is an allowed app), or a plain Telegram text
 * message. The player authorizes CallMeBot once, see README.md.
 */
function callMeBot(endpoint, text, extra = '') {
  const url = '/' + endpoint + '.php?source=web&user=' + encodeURIComponent(sails.config.travian.telegramUser)
    + '&text=' + encodeURIComponent(text) + extra;
  return TravianService.request('GET', url, { host: 'api.callmebot.com' }).then(res => {
    if (res.status !== 200) throw new Error('CallMeBot ' + endpoint + ' HTTP ' + res.status + ': ' + res.body.slice(0, 200));
    const answer = res.body.replace(/<script[^]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    sails.log.info('CallMeBot ' + endpoint + ': ' + answer.slice(0, 500));
    return answer;
  });
}

module.exports = {
  // rpt=2: the text is read twice, for a half-awake listener.
  call: text => callMeBot('start', text, '&lang=' + encodeURIComponent(sails.config.travian.callLang) + '&rpt=2'),
  message: text => callMeBot('text', text),
};
