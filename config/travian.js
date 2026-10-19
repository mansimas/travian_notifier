/**
 * sails.config.travian - everything the attack watcher needs. Secrets come from .env (see
 * .env.example), which is never committed.
 */
module.exports.travian = {
  watch: true,

  // The game world as in the browser address bar, e.g. ts30.x3.europe.travian.com
  server: (process.env.TRAVIAN_SERVER || '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
  username: process.env.TRAVIAN_USERNAME,
  password: process.env.TRAVIAN_PASSWORD,

  // The Telegram @username CallMeBot calls, and the voice it reads the alarm with.
  telegramUser: process.env.TELEGRAM_USER,
  callLang: process.env.CALL_LANG || 'en-GB-Standard-B',
  // CallMeBot hangs up after 30 seconds, so a longer alarm is several calls: callCount calls,
  // callGapSeconds apart (CallMeBot refuses two calls to one user within 65 seconds; a second
  // call within 3 minutes also passes the iPhone's "repeated calls" exception in Sleep Focus).
  // Each call reads the text callRepeat times.
  callCount: Number(process.env.CALL_COUNT || 1),
  callGapSeconds: Number(process.env.CALL_GAP_SECONDS || 70),
  callRepeat: Number(process.env.CALL_REPEAT || 3),
  // After an alarm, no other alarm for this long: new attacks meanwhile are only logged.
  callCooldownHours: Number(process.env.CALL_COOLDOWN_HOURS || 10),

  // GET /oases and npm run oases: the village the oasis stages are counted from (by name;
  // the first village when not set).
  oasisVillage: process.env.OASIS_VILLAGE,

  // Auto raids (AutoRaidService): every minMinutes..maxMinutes (random) each village raids
  // oases of its first stages as long as troops last. Mode 'empty': Mercenaries to empty oases,
  // perStage[stage] each. Mode 'animals': oases with animals, armies by RaidPlanService;
  // cavOnly: with the horses alone. Entries go in this order, each on the oases left over.
  // AUTO_RAID_SEND=0 = dry run: everything is read and logged, nothing is sent and no report
  // is opened. GET /stop and /start pause and resume the sends.
  autoRaid: {
    enabled: process.env.AUTO_RAID === '1',
    send: process.env.AUTO_RAID_SEND !== '0',
    villages: [
      { name: 'mansim1', mode: 'empty', unit: 'u61', stages: 4, perStage: { 1: 50, 2: 50, 3: 100, 4: 100 } },
      { name: 'mansim2', mode: 'animals', stages: 8, maxStages: 10 },
      // mansim1's horses go on where mansim2's horses ran out.
      { name: 'mansim1', mode: 'animals', cavOnly: true, stages: 8, maxStages: 10 },
    ],
    minMinutes: 1,
    maxMinutes: 5,
    // Pause between two sends of one round, and between other page loads.
    sendGapSeconds: [2, 6],
    pageGapSeconds: [1, 3],
  },

  // Times on the /mute page are shown in this zone.
  timezone: process.env.TIMEZONE || 'Europe/Vilnius',

  // Checks are pollMinutes apart plus up to pollJitterMinutes, so they do not come at a
  // machine-like steady beat.
  pollMinutes: Number(process.env.POLL_MINUTES || 3),
  pollJitterMinutes: Number(process.env.POLL_JITTER_MINUTES || 2),

  // After a failed check: wait errorPauseMinutes, doubling up to errorPauseMaxMinutes.
  errorPauseMinutes: 2,
  errorPauseMaxMinutes: 30,

  // A problem text goes out after this many failed checks in a row, and not again before
  // problemRepeatHours.
  problemAfterFails: 3,
  problemRepeatHours: 6,
};
