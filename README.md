# travian_notifier

Rings your iPhone with a free Telegram call when one of your Travian villages gets an incoming attack.

It runs on a server, so your PC can be off. Every 3–5 minutes it logs in to your account and reads `dorf1.php`, the same page the game shows you. The page carries the game's own count of incoming attacks for every village (`incomingAttacksAmount`). A village whose count went up since the last check means a new attack.

Each new attack rings a few calls in a row, made by [CallMeBot](https://www.callmebot.com/blog/telegram-phone-call-using-api/). A voice reads out which villages are attacked and when the first attack lands. If the notifier stops working (login refused, page changed), you get a Telegram text message instead of a call, at most once every 6 hours.


## 1. Telegram + CallMeBot (one time)

1. In Telegram, go to **Settings → Username** and set a username.
2. Allow CallMeBot to call you: open https://api2.callmebot.com/txt/login.php and log in with Telegram, or send `/start` to **@CallMeBot_txtbot**.
3. Go to Telegram → **Settings → Privacy and Security → Calls** and set it to **Everybody**, since CallMeBot is not one of your contacts.

## 2. iPhone at night

Telegram calls ring like phone calls, but Sleep mode blocks them unless you let them through:
- **Settings → Focus → Sleep → Apps → Add** → Telegram (and turn on *Time Sensitive Notifications*).
- Keep the **ring/silent switch on ring**. In silent mode a call only vibrates.
- Ringer volume: **Settings → Sounds & Haptics** → slider to max, and turn off **Change with Buttons** so it is not lowered by accident.
- **Settings → Face ID & Passcode → Attention Aware Features** off, or the ringer gets quieter as soon as you look at the phone.
- Each call lasts at most 30 seconds (CallMeBot's limit), so an attack rings `CALL_COUNT` calls (default 3), 70 seconds apart.
- Test it for real: turn Sleep Focus on, lock the phone and run `npm run test-call` (one call) or `npm run test-alarm` (the full alarm), see step 3.

## 3. Server (first time)

A Sails app like the games: pm2 app `TravianNotifier`, port 1421 on loopback only (no nginx).

```bash
git clone git@github.com:mansimas/travian_notifier.git ~/travian_notifier
cd ~/travian_notifier && npm install
cp .env.example .env && nano .env && chmod 600 .env   # world, username, password, @telegram
npm run check       # logs in once, lists your villages and attacks, saves dorf1.html
npm run test-call   # your phone should ring
pm2 start ecosystem.config.js && pm2 save
```

After that, deploy from your machine with `deploy` inside `~/travian_notifier`, as with the games. It runs `git pull` and then `rr`, which is `npm run restart` = `pm2 reload TravianNotifier`. If `package.json` dependencies change, run `npm install` on the server once.

On the server:
- `curl -s localhost:1421/status` shows what the last check saw.
- `pm2 logs TravianNotifier` shows the log.

Locally, `node app.js` lifts without watching. Use `WATCH=1 node app.js` to watch for real.

## Notes

- `npm run check` prints the incoming attack count of every village. Run it once while a real attack is coming, to confirm the count shows it.
- The account is logged in from the server's IP while you play from home. Travian allows this (it is what phones do), but it is still your account and your risk. Automation that *plays* is against the rules; this only reads one page.
- `.env`, `.tmp/state.json` (what the last check saw, so a restart does not ring again) and `dorf1.html` stay on the server and are never committed.
