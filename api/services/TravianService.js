/**
 * TravianService
 *
 * Logs in to the Travian account in sails.config.travian and reads dorf1.php, the village
 * overview page: which villages are under attack, and how many attacks are coming at the active
 * one. Plain https with its own cookie jar, no browser.
 */
const https = require('https');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

let cookies = {};

// A failure worth telling the player about, by kind ('login', 'page').
class Problem extends Error {
  constructor(kind, text) { super(text); this.kind = kind; }
}

// One request, following redirects and keeping cookies. Resolves { status, url, body } of the
// last hop. host defaults to the game world.
function request(method, url, { body, headers = {}, host = sails.config.travian.server } = {}, hops = 0) {
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

// The same two steps as the login form: the password buys a one-time code, the code buys the
// session cookie.
async function login() {
  const { username, password } = sails.config.travian;
  cookies = {};
  await request('GET', '/');
  const res = await request('POST', '/api/v1/auth/login', {
    body: JSON.stringify({ name: username, password, w: '1920:1080', mobileOptimizations: false }),
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
  });
  let code;
  try { code = JSON.parse(res.body).code; } catch (e) { /* not json: refused below */ }
  if (!code) throw new Problem('login', 'Travian login refused (HTTP ' + res.status + '): ' + res.body.slice(0, 200));
  await request('GET', '/api/v1/auth?code=' + encodeURIComponent(code) + '&response_type=redirect');
  sails.log.info('travian: logged in as ' + username);
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
    if (!loggedIn(res.body)) throw new Problem('page', 'Logged in but dorf1.php has no village list. Run npm run check and look at dorf1.html');
  }
  return res.body;
}

// Villages from the sidebar list, each { id, name, attacked }. The game marks a village under
// attack with an "attack" class (the red swords icon).
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

// Incoming attacks on the active village from the troop movements box: { count, inSeconds }
// (inSeconds is the first arrival), or null if none.
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

// Everything one look at dorf1.php tells: { html, villages, active, movements }.
async function read() {
  const html = await loadDorf1();
  const villages = parseVillages(html);
  if (!villages.length) throw new Problem('page', 'No villages found on dorf1.php, the page layout may have changed. Run npm run check.');
  return { html, villages, active: activeVillageName(html), movements: parseMovements(html) };
}

module.exports = { Problem, request, read, parseVillages, parseMovements, activeVillageName };
