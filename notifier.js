// Travian attack notifier: logs in to your Travian account from the server,
// looks at the village list every few minutes and, when one of your villages
// gets a new incoming attack, rings your phone with a Telegram call through
// CallMeBot (free). Problems (login refused, page changed) are sent as one
// Telegram text message instead, never as a call.
//
//   node notifier.js              run forever (pm2 runs this)
//   node notifier.js --check      log in once, print what it sees, save the page
//   node notifier.js --test-call  ring the phone once
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

loadEnv(path.join(__dirname, '.env'));

const SERVER = (process.env.TRAVIAN_SERVER || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const USERNAME = process.env.TRAVIAN_USERNAME;
const PASSWORD = process.env.TRAVIAN_PASSWORD;
const TELEGRAM_USER = process.env.TELEGRAM_USER; // @username that CallMeBot calls
const CALL_LANG = process.env.CALL_LANG || 'en-GB-Standard-B';
// Checks are POLL_MINUTES apart plus up to POLL_JITTER_MINUTES, so they do not
// come at a machine-like steady beat.
const POLL_MS = Number(process.env.POLL_MINUTES || 3) * 60 * 1000;
const JITTER_MS = Number(process.env.POLL_JITTER_MINUTES || 2) * 60 * 1000;
// After a failed check: wait this long, doubling up to ERROR_PAUSE_MAX_MS.
const ERROR_PAUSE_MS = 2 * 60 * 1000;
const ERROR_PAUSE_MAX_MS = 30 * 60 * 1000;
// A problem text is sent after this many failed checks in a row, and the
// same problem is not sent again before PROBLEM_REPEAT_MS.
const PROBLEM_AFTER_FAILS = 3;
const PROBLEM_REPEAT_MS = 6 * 60 * 60 * 1000;
const STATE_FILE = path.join(__dirname, 'state.json');
const DUMP_FILE = path.join(__dirname, 'dorf1.html');
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

let cookies = {};

// ---- http ------------------------------------------------------------------

// One request to host, following redirects and keeping cookies. Resolves
// { status, url, body } of the last hop.
function request(method, url, { body, headers = {}, host = SERVER } = {}, hops = 0) {
  const target = new URL(url, 'https://' + host);
  return new Promise((resolve, reject) => {
    const req = https.request(target, {
      method,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; '),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
      timeout: 30 * 1000,
    }, res => {
      for (const line of res.headers['set-cookie'] || []) {
        const [pair] = line.split(';');
        const at = pair.indexOf('=');
        cookies[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const location = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && location && hops < 5) {
          const next = new URL(location, target);
          resolve(request('GET', next.href, { host: next.host }, hops + 1));
        } else {
          resolve({ status: res.statusCode, url: target.href, body: Buffer.concat(chunks).toString('utf8') });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out: ' + target.href)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---- travian ---------------------------------------------------------------

// The same two steps as the login form: the password buys a one-time code,
// the code buys the session cookie.
async function login() {
  cookies = {};
  await request('GET', '/');
  const res = await request('POST', '/api/v1/auth/login', {
    body: JSON.stringify({ name: USERNAME, password: PASSWORD, w: '1920:1080', mobileOptimizations: false }),
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
  });
  let code;
  try { code = JSON.parse(res.body).code; } catch (e) { /* not json: refused below */ }
  if (!code) throw new Problem('login', 'Travian login refused (HTTP ' + res.status + '): ' + res.body.slice(0, 200));
  await request('GET', '/api/v1/auth?code=' + encodeURIComponent(code) + '&response_type=redirect');
  log('logged in');
}

function loggedIn(html) {
  return html.includes('sidebarBoxVillagelist') || html.includes('id="villageName"');
}

// dorf1.php, logging in first when the session has run out.
async function loadDorf1() {
  let res = await request('GET', '/dorf1.php');
  if (!loggedIn(res.body)) {
    await login();
    res = await request('GET', '/dorf1.php');
    if (!loggedIn(res.body)) throw new Problem('page', 'Logged in but dorf1.php has no village list. Run --check and look at ' + DUMP_FILE);
  }
  return res.body;
}

// Villages from the sidebar list, each { id, name, attacked }. The game marks
// a village under attack with an "attack" class (the red swords icon).
function parseVillages(html) {
  const villages = [];
  const parts = html.split(/<div[^>]*class="[^"]*\blistEntry\b/).slice(1);
  for (const entry of parts) {
    const classes = (entry.match(/^([^"]*)"/) || [, ''])[1]; // the rest of the listEntry class list
    const id = (entry.match(/data-did="(\d+)"/) || entry.match(/newdid=(\d+)/) || [])[1];
    const name = decode((entry.match(/class="name"[^>]*>([^<]*)</) || [, '?'])[1]);
    const attacked = /\battack\b/.test(classes) || /<[^>]*class="[^"]*\battack\b/.test(entry);
    if (id || name !== '?') villages.push({ id: id || name, name, attacked });
  }
  return villages;
}

// Incoming attacks on the active village from the troop movements box:
// { count, inSeconds } (inSeconds is the first arrival), or null if none.
function parseMovements(html) {
  const start = html.indexOf('id="movements"');
  if (start < 0) return null;
  const box = html.slice(start, html.indexOf('</table>', start));
  const row = box.split('<tr').find(r => /class="att1"|class="a1"/.test(r));
  if (!row) return null;
  const count = Number((decode(row).match(/class="a1"[^>]*>\s*(\d+)/) || [, 1])[1]);
  const timer = (row.match(/class="timer"[^>]*value="(\d+)"/) || row.match(/value="(\d+)"[^>]*class="timer"/) || [])[1];
  return { count, inSeconds: timer ? Number(timer) : null };
}

function activeVillageName(html) {
  const m = html.match(/class="listEntry[^"]*\bactive\b[^]*?class="name"[^>]*>([^<]*)</) || html.match(/<input[^>]*id="villageName"[^>]*value="([^"]*)"/);
  return m ? decode(m[1]) : null;
}

function decode(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).trim();
}

// ---- phone -----------------------------------------------------------------

function callMeBot(endpoint, text, extra = '') {
  const url = '/' + endpoint + '.php?source=web&user=' + encodeURIComponent(TELEGRAM_USER) + '&text=' + encodeURIComponent(text) + extra;
  return request('GET', url, { host: 'api.callmebot.com' }).then(res => {
    if (res.status !== 200) throw new Error('CallMeBot ' + endpoint + ' HTTP ' + res.status + ': ' + res.body.slice(0, 200));
    log('CallMeBot ' + endpoint + ': ' + res.body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
  });
}

const call = text => callMeBot('start', text, '&lang=' + encodeURIComponent(CALL_LANG) + '&rpt=2');
const message = text => callMeBot('text', text);

// ---- loop ------------------------------------------------------------------

class Problem extends Error {
  constructor(kind, text) { super(text); this.kind = kind; }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// What deserves a call: a village that was not under attack before, or more
// attacks on the active village than last time.
function newAttacks(state, villages, active, movements) {
  const before = new Set(state.attacked || []);
  const fresh = villages.filter(v => v.attacked && !before.has(v.id)).map(v => v.name);
  const count = movements ? movements.count : 0;
  if (active && count > ((state.activeCounts || {})[active] || 0) && !fresh.includes(active)) fresh.push(active);
  return fresh;
}

async function check(state) {
  const html = await loadDorf1();
  const villages = parseVillages(html);
  if (!villages.length) throw new Problem('page', 'No villages found on dorf1.php, the page layout may have changed. Run --check.');
  const active = activeVillageName(html);
  const movements = parseMovements(html);
  const fresh = newAttacks(state, villages, active, movements);
  if (fresh.length) {
    let text = 'Travian alarm. ' + fresh.join(', ') + ' under attack.';
    if (movements && movements.inSeconds != null && fresh.includes(active)) {
      text += ' First attack on ' + active + ' arrives in ' + Math.round(movements.inSeconds / 60) + ' minutes.';
    }
    log(text);
    await call(text);
  }
  state.attacked = villages.filter(v => v.attacked).map(v => v.id);
  state.activeCounts = active ? { [active]: movements ? movements.count : 0 } : {};
  writeState(state);
  return { villages, active, movements };
}

async function run() {
  const state = readState();
  let fails = 0;
  let pause = ERROR_PAUSE_MS;
  log('watching ' + SERVER + ' as ' + USERNAME);
  for (;;) {
    let wait = POLL_MS + Math.random() * JITTER_MS;
    try {
      await check(state);
      fails = 0;
      pause = ERROR_PAUSE_MS;
    } catch (e) {
      fails++;
      log('check failed (' + fails + '): ' + e.message);
      wait = pause;
      pause = Math.min(pause * 2, ERROR_PAUSE_MAX_MS);
      if (fails >= PROBLEM_AFTER_FAILS && Date.now() - (state.problemSentAt || 0) > PROBLEM_REPEAT_MS) {
        state.problemSentAt = Date.now();
        writeState(state);
        await message('Travian notifier is NOT watching your villages: ' + e.message).catch(err => log('problem text failed: ' + err.message));
      }
    }
    await new Promise(r => setTimeout(r, wait));
  }
}

async function runCheck() {
  const html = await loadDorf1();
  fs.writeFileSync(DUMP_FILE, html);
  const villages = parseVillages(html);
  console.log('active village:', activeVillageName(html));
  console.log('villages:');
  for (const v of villages) console.log('  ' + (v.attacked ? 'UNDER ATTACK ' : '             ') + v.name + ' (' + v.id + ')');
  console.log('incoming attacks on active village:', parseMovements(html) || 'none');
  console.log('page saved to', DUMP_FILE);
}

function log(text) {
  console.log(new Date().toISOString() + ' ' + text);
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const missing = ['TRAVIAN_SERVER', 'TRAVIAN_USERNAME', 'TRAVIAN_PASSWORD', 'TELEGRAM_USER'].filter(k => !process.env[k]);
if (missing.length) {
  console.error('Missing in .env: ' + missing.join(', ') + ' (see .env.example)');
  process.exit(1);
}

const arg = process.argv[2];
const job = arg === '--check' ? runCheck()
  : arg === '--test-call' ? call('Travian alarm test. Your notifier can wake you up.')
  : run();
job.catch(e => { console.error(e.message); process.exit(1); });
