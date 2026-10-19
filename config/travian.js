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

  // Auto raids (AutoRaidService): every minMinutes..maxMinutes (random) the village sends
  // Mercenaries to the empty never-owned oases of the first stages, closest first, as long as
  // troops last. AUTO_RAID_SEND=0 = dry run: everything is read and logged, nothing is sent
  // and no report is opened.
  autoRaid: {
    enabled: process.env.AUTO_RAID === '1',
    send: process.env.AUTO_RAID_SEND !== '0',
    village: process.env.AUTO_RAID_VILLAGE || 'mansim1',
    // Villages whose outgoing troops are checked, so no oasis gets a second raid.
    watchVillages: (process.env.AUTO_RAID_WATCH || 'mansim1,mansim2').split(',').map(s => s.trim()).filter(Boolean),
    unit: 'u61', // Mercenary
    perStage: { 1: 50, 2: 50, 3: 100, 4: 100 },
    minMinutes: 1,
    maxMinutes: 10,
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
