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
  // CallMeBot answers only once the call is over (up to 30 s of ringing plus the talk), so wait long.
  return TravianService.request('GET', url, { host: 'api.callmebot.com', timeout: 2 * 60 * 1000 }).then(res => {
    if (res.status !== 200) throw new Error('CallMeBot ' + endpoint + ' HTTP ' + res.status + ': ' + res.body.slice(0, 200));
    const answer = res.body.replace(/<script[^]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    sails.log.info('CallMeBot ' + endpoint + ': ' + answer.slice(0, 500));
    // A refused call still comes back HTTP 200, with "Error: ..." in the text.
    const error = answer.match(/Error:\s*(.*?)(?: Please see the FAQ| End\.|$)/i);
    if (error) throw new Error('CallMeBot ' + endpoint + ' refused: ' + error[1]);
    return answer;
  });
}

module.exports = {
  call: text => callMeBot('start', text, '&lang=' + encodeURIComponent(sails.config.travian.callLang) + '&rpt=' + sails.config.travian.callRepeat),

  // The alarm: callCount calls, callGapSeconds apart. Resolves once all are placed; throws only
  // if none got through.
  alarm: async function (text) {
    const { callCount, callGapSeconds } = sails.config.travian;
    let placed = 0;
    let lastError;
    for (let i = 0; i < callCount; i++) {
      if (i) await new Promise(r => setTimeout(r, callGapSeconds * 1000));
      try {
        await module.exports.call(text);
        placed++;
      } catch (e) {
        lastError = e;
        sails.log.error('alarm call ' + (i + 1) + '/' + callCount + ': ' + e.message);
      }
    }
    if (!placed) throw lastError;
  },
  message: text => callMeBot('text', text),
};
