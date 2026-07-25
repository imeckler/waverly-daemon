// Validates whether undici's connection pooling causes the daemon's heartbeat
// ECONNRESET. Run on the Pi (where the Shelly is reachable):
//
//   PW=$(awk -F\" '/"password"[[:space:]]*:/{print $4; exit}' config.json)
//   scp test-heartbeat.js waverly@waverlypi.local:/tmp/
//   ssh waverly@waverlypi.local "SHELLY_PASSWORD='$PW' node /tmp/test-heartbeat.js"
//
// Outputs one line per test. Hypothesis: test 1 succeeds, test 2 ECONNRESETs,
// test 3 succeeds (Connection: close stops undici from reusing the pool entry).
'use strict';

const crypto = require('crypto');
const http = require('http');

const IP = process.argv[2] || '10.0.0.224';
const PASSWORD = process.env.SHELLY_PASSWORD;
if (!PASSWORD) {
  console.error('SHELLY_PASSWORD env var required');
  process.exit(1);
}

function parseDigestChallenge(header) {
  const fields = {};
  const params = header.replace(/^Digest\s+/i, '');
  const re = /(\w+)=(?:"([^"]+)"|([^\s,]+))/g;
  let match;
  while ((match = re.exec(params)) !== null) {
    fields[match[1]] = match[2] ?? match[3];
  }
  return fields;
}

function buildDigestAuth(username, password, method, uri, challenge, nc) {
  const { realm, nonce, qop, algorithm } = challenge;
  const algo = (algorithm ?? 'MD5').toUpperCase();
  const hashFn = algo === 'SHA-256' ? 'sha256' : 'md5';
  const ncHex = nc.toString(16).padStart(8, '0');
  const cnonce = crypto.randomBytes(16).toString('hex');
  const ha1 = crypto.createHash(hashFn).update(`${username}:${realm}:${password}`).digest('hex');
  const ha2 = crypto.createHash(hashFn).update(`${method}:${uri}`).digest('hex');
  const response = qop === 'auth'
    ? crypto.createHash(hashFn).update(`${ha1}:${nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`).digest('hex')
    : crypto.createHash(hashFn).update(`${ha1}:${nonce}:${ha2}`).digest('hex');
  let header = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm=${algo}, response="${response}"`;
  if (qop) header += `, qop=${qop}, nc=${ncHex}, cnonce="${cnonce}"`;
  return header;
}

async function digestPost(path, body, extraHeaders = {}) {
  const url = `http://${IP}${path}`;
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  const init = { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) };
  const r1 = await fetch(url, init);
  if (r1.status !== 401) return r1;
  const wwwAuth = r1.headers.get('www-authenticate');
  if (!wwwAuth) throw new Error('401 with no WWW-Authenticate');
  const auth = buildDigestAuth('admin', PASSWORD, 'POST', path, parseDigestChallenge(wwwAuth), 1);
  const init2 = { ...init, headers: { ...headers, Authorization: auth } };
  return await fetch(url, init2);
}

async function attempt(label, fn) {
  try {
    const r = await fn();
    console.log(`${label}: ${r.status} ${r.statusText}`);
  } catch (e) {
    const cause = e.cause ? ` (cause: ${e.cause.code || e.cause.message})` : '';
    console.log(`${label}: ERROR ${e.message}${cause}`);
  }
}

async function main() {
  console.log(`Target: ${IP}`);
  console.log('--- Test 1: heartbeat alone, fresh process state ---');
  await attempt('  heartbeat', () => digestPost('/script/1/heartbeat', '{}'));

  console.log('--- Test 2: warm up with Sys.GetStatus, then heartbeat (default pool) ---');
  await attempt('  warmup Sys.GetStatus', () => digestPost('/rpc/Sys.GetStatus', '{}'));
  await attempt('  heartbeat', () => digestPost('/script/1/heartbeat', '{}'));

  console.log('--- Test 3: warm up, then heartbeat with Connection: close ---');
  await attempt('  warmup Sys.GetStatus', () => digestPost('/rpc/Sys.GetStatus', '{}'));
  await attempt('  heartbeat (Connection: close)', () => digestPost('/script/1/heartbeat', '{}', { 'Connection': 'close' }));

  console.log('--- Test 4: heartbeat via node:http (bypasses undici/fetch entirely) ---');
  await attempt('  heartbeat (node:http)', () => digestPostHttp('/script/1/heartbeat', '{}'));

  console.log('--- Test 5: GET instead of POST (script endpoints may accept GET) ---');
  await attempt('  heartbeat (GET)', () => fetch(`http://${IP}/script/1/heartbeat`, { method: 'GET', signal: AbortSignal.timeout(5000) }).then(handleAuthRetry('/script/1/heartbeat', 'GET', null)));

  console.log('--- Test 6: User-Agent: curl/8.0 spoofed ---');
  await attempt('  heartbeat (curl UA)', () => digestPost('/script/1/heartbeat', '{}', { 'User-Agent': 'curl/8.0.1' }));

  console.log('--- Test 7: raw TCP, hand-crafted request (mimic curl bytes) ---');
  await attempt('  heartbeat (raw socket)', () => rawDigestPost('/script/1/heartbeat'));
}

function handleAuthRetry(path, method, body) {
  return async (r1) => {
    if (r1.status !== 401) return r1;
    const wwwAuth = r1.headers.get('www-authenticate');
    const auth = buildDigestAuth('admin', PASSWORD, method, path, parseDigestChallenge(wwwAuth), 1);
    const init = { method, headers: { Authorization: auth }, signal: AbortSignal.timeout(5000) };
    if (body !== null) { init.headers['Content-Type'] = 'application/json'; init.body = body; }
    return fetch(`http://${IP}${path}`, init);
  };
}

const net = require('net');

function rawRequest(reqBytes) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: IP, port: 80, timeout: 5000 });
    const chunks = [];
    sock.on('connect', () => sock.write(reqBytes));
    sock.on('data', c => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString()));
    sock.on('error', reject);
    sock.on('timeout', () => { sock.destroy(new Error('timeout')); });
  });
}

async function rawDigestPost(path) {
  // First: bare POST to get challenge
  const req1 = `POST ${path} HTTP/1.1\r\nHost: ${IP}\r\nUser-Agent: curl/8.0.1\r\nAccept: */*\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`;
  const r1 = await rawRequest(req1);
  const status1 = parseInt(r1.split(' ')[1], 10);
  if (status1 !== 401) return { status: status1, statusText: r1.split('\r\n')[0] };
  const wwwAuthLine = r1.split('\r\n').find(l => l.toLowerCase().startsWith('www-authenticate:'));
  const wwwAuth = wwwAuthLine.substring(wwwAuthLine.indexOf(':') + 1).trim();
  const auth = buildDigestAuth('admin', PASSWORD, 'POST', path, parseDigestChallenge(wwwAuth), 1);
  const req2 = `POST ${path} HTTP/1.1\r\nHost: ${IP}\r\nUser-Agent: curl/8.0.1\r\nAccept: */*\r\nAuthorization: ${auth}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`;
  const r2 = await rawRequest(req2);
  const status2 = parseInt(r2.split(' ')[1], 10);
  return { status: status2, statusText: r2.split('\r\n')[0] };
}

function httpPost(path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: IP, port: 80, method: 'POST', path,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, statusText: res.statusMessage, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

async function digestPostHttp(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const r1 = await httpPost(path, headers, body);
  if (r1.status !== 401) return r1;
  const wwwAuth = r1.headers['www-authenticate'];
  const auth = buildDigestAuth('admin', PASSWORD, 'POST', path, parseDigestChallenge(wwwAuth), 1);
  return await httpPost(path, { ...headers, Authorization: auth }, body);
}

main().catch(e => { console.error(e); process.exit(1); });
