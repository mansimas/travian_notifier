# travian_notifier

Rings your iPhone with a free Telegram call when one of your Travian villages gets an incoming attack.

It runs on a server, so your PC can be off. Every 3–5 minutes it logs in to your account and reads `dorf1.php`, the same page the game shows you. Two things count as a new attack:
- a village that was not under attack before shows the red swords in the village list;
- the active village shows more incoming attacks than at the last check.

Each new attack gives one call, made by [CallMeBot](https://www.callmebot.com/blog/telegram-phone-call-using-api/). A voice reads out which villages are attacked and when the first attack lands. If the notifier stops working (login refused, page changed), you get a Telegram text message instead of a call, at most once every 6 hours.

No npm packages are needed. It runs on Node 16 or newer.

## 1. Telegram + CallMeBot (one time)

1. In Telegram, go to **Settings → Username** and set a username.
2. Allow CallMeBot to call you: open https://api2.callmebot.com/txt/login.php and log in with Telegram, or send `/start` to **@CallMeBot_txtbot**.
3. Go to Telegram → **Settings → Privacy and Security → Calls** and set it to **Everybody**, since CallMeBot is not one of your contacts.

## 2. iPhone at night

Telegram calls ring like phone calls, but Sleep mode blocks them unless you let them through:
- **Settings → Focus → Sleep → Apps → Add** → Telegram (and turn on *Time Sensitive Notifications*).
- Keep the **ring/silent switch on ring**. In silent mode a call only vibrates.
- Test it for real: turn Sleep Focus on, lock the phone and run `npm run test-call` (step 3).

## 3. Server

```bash
git clone https://github.com/mansimas/travian_notifier.git ~/travian_notifier
cd ~/travian_notifier
cp .env.example .env && nano .env      # world, username, password, @telegram
chmod 600 .env
npm run check       # logs in once, lists your villages and attacks, saves dorf1.html
npm run test-call   # your phone should ring
pm2 start ecosystem.config.js && pm2 save
pm2 logs TravianNotifier
```

The pm2 app is called `TravianNotifier`. The games' deploys reload only their own apps by name, so they don't touch it.

Update later with `git pull && pm2 restart TravianNotifier`.

## Notes

- `npm run check` prints `UNDER ATTACK` next to attacked villages. The first time you have a real incoming attack, run it and confirm that the right village is flagged. If nothing is flagged, keep the saved `dorf1.html`: it shows how the game marks the attack.
- The account is logged in from the server's IP while you play from home. Travian allows this (it is what phones do), but it is still your account and your risk. Automation that *plays* is against the rules; this only reads one page.
- `.env`, `state.json` and `dorf1.html` stay on the server and are never committed.
