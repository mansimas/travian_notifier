/**
 * sails.config.travian - everything the attack watcher needs. Secrets come from .env (see
 * .env.example), which is never committed.
 */
// Natar villages no entry raids (2026-10-23 reports, 24 h: -87|40 26 raids 0 loot; -94|47,
// -89|49, -87|49, -97|48 under 50 loot per raid; 2026-10-26: -99|44 19 raids 1,875 loot).
const NATAR_SKIP = ['-87|40', '-94|47', '-89|49', '-87|49', '-97|48', '-99|44'];

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
  // cavOnly: with the horses alone. Mode 'natars': per units to each Natar village within radius. Mode 'players': n units to each target every everyMinutes. Entries go in this order, each on the oases left over.
  // AUTO_RAID_SEND=0 = dry run: everything is read and logged, nothing is sent and no report
  // is opened. GET /stop and /start pause and resume the sends.
  autoRaid: {
    enabled: process.env.AUTO_RAID === '1',
    send: process.env.AUTO_RAID_SEND !== '0',
    villages: [
      // restMinutes: an oasis gets no empty raid until this long after our last raid hit it.
      { name: 'mansim1', mode: 'empty', unit: 'u61', stages: 5, perStage: { 1: 50, 2: 50, 3: 100, 4: 100, 5: 100 }, restMinutes: 60 },
      // mansim3's Mercenaries go on with the empty oases mansim1 left, same rules.
      { name: 'mansim3', mode: 'empty', unit: 'u61', stages: 5, perStage: { 1: 50, 2: 50, 3: 100, 4: 100, 5: 100 }, restMinutes: 60 },
      // mansim2's Marksmen raid player villages (user, 2026-10-25): n each every everyMinutes, not
      // waiting for the last raid to come back. The Marksmen these raids keep busy are held back
      // from mansim2's later entries, the rest raid oases. owner and village (name) as on the map:
      // the send checks the owner, the reports are found by the village name. A raid losing more
      // than maxLoss of its army or more than maxLossUnits troops leaves that target alone until /start.
      // n: the most a raid takes; the army is sized by the last loot (AutoRaidService playerArmy).
      { name: 'mansim2', mode: 'players', unit: 'u65', everyMinutes: 60, maxLoss: 0.2, maxLossUnits: 20, targets: [
        { key: '-86|60', n: 100, owner: 'old_marshall', village: 'GHETTO' },
        { key: '-78|49', n: 50, owner: 'lerchik', village: 'Деревня lerchik' },
        { key: '-117|33', n: 50, owner: 'Jerem', village: 'Village de Jerem' },
        { key: '-83|60', n: 200, owner: 'kurdesz', village: 'Osada: kurdesz' },
        { key: '-86|57', n: 100, owner: 'kurdesz', village: 'Nowa osada' },
      ] },
      { name: 'mansim2', mode: 'animals', stages: 8, maxStages: 14 },
      // mansim1's horses go on where mansim2's horses ran out.
      { name: 'mansim1', mode: 'animals', cavOnly: true, stages: 8, maxStages: 14 },
      // mansim3's Marksmen raid Natar villages: 10 each (more to rich ones, AutoRaidService
      // natarTarget), within 37 fields (about 15 oasis stages: stage 14 ends at 36).
      // skip: Natar villages never raided (NATAR_SKIP). Poor ones are also left alone by their
      // reports for a while.
      // often: hits N times as often (-86|48 gave 60% of the Natar loot, 2026-10-23).
      { name: 'mansim3', mode: 'natars', unit: 'u65', per: 10, radius: 37, often: { '-86|48': 2 },
        skip: NATAR_SKIP },
      // mansim3's Marksmen the Natar raids leave at home farm mansim2's oases with animals, on
      // what mansim2's and mansim1's horses left (user, 2026-10-25: 323 idle, nearly every Natar
      // village left alone as poor).
      { name: 'mansim3', mode: 'animals', cavOnly: true, oasesOf: 'mansim2', stages: 8, maxStages: 14 },
      // mansim1's Marksmen the oasis raids left at home extend mansim3's (2026-10-23: 164 at home,
      // no oasis passed the rules; the villages are a field apart): they go to the Natar villages
      // mansim3 had no Marksmen for, never to one with a raid of ours on its way (single).
      { name: 'mansim1', mode: 'natars', unit: 'u65', per: 10, radius: 37, single: true, skip: NATAR_SKIP },
      // Steppe Riders the animal raids left at home raid Natar villages too (2026-10-23).
      { name: 'mansim2', mode: 'natars', unit: 'u64', per: 10, radius: 37, skip: NATAR_SKIP },
      { name: 'mansim1', mode: 'natars', unit: 'u64', per: 10, radius: 37, skip: NATAR_SKIP },
    ],
    // No horses to an oasis our raids hit less than this long ago: right after a clear it refills
    // fast (2 wolves seen, 10 there on arrival, 2026-10-20).
    horseRestMinutes: 120,
    minMinutes: 1,
    maxMinutes: 3,
    // Pause between two sends of one round, and between other page loads.
    sendGapSeconds: [2, 6],
    pageGapSeconds: [1, 3],
  },

  // VillageWatchService: every everyMinutes (random in the range) the population of every player
  // village of at least minPop within radius fields of village (by name; oasisVillage when not
  // set), to tell active players from inactive ones. GET /villages, npm run villages.
  villageWatch: {
    enabled: process.env.VILLAGE_WATCH !== '0',
    village: process.env.VILLAGE_WATCH_VILLAGE || process.env.OASIS_VILLAGE,
    radius: 50, // up to ~25 map requests per snapshot (30: 9)
    minPop: 200,
    everyMinutes: [13, 17],
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
