import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeSync } from 'node:fs';
import { once } from 'node:events';
import { basename, join, resolve } from 'node:path';
import { networkInterfaces, tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createMarketplaceService, installShutdownHandlers, listen } from '/app/dist/index.js';

const childNames = ['Xvfb', 'x11vnc', 'websockify'];
const browserRoot = resolve(process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/ms-playwright');
const profileDir = resolve(process.env.BROWSER_PROFILE_DIR ?? '/home/node/.marketplace/browser-profile');
const originalStderrWrite = process.stderr.write.bind(process.stderr);
let capturedStdout = '';
let capturedStderr = '';
let assertionsPassed = false;
let service;
let syntheticServer;
const tokens = [];
const consoleUrls = [];
const skippedChecks = [];

function captureStream(stream, append) {
  stream.write = (chunk, encoding, callback) => {
    append(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
}

captureStream(process.stdout, (text) => { capturedStdout += text; });
captureStream(process.stderr, (text) => { capturedStderr += text; });

function getProcesses() {
  const processes = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (argv.length > 0) processes.push({ pid: Number(entry), argv });
    } catch {
      // Processes can exit between listing /proc and reading cmdline.
    }
  }
  return processes;
}

function isChromiumArg(arg) {
  return arg.startsWith(`${browserRoot}/chromium-`) && /\/(?:chrome|chrome-headless-shell)$/.test(arg);
}

function runningChildren() {
  const processes = getProcesses();
  const found = new Set();
  for (const process of processes) {
    for (const name of childNames) {
      if (process.argv.some((arg) => basename(arg) === name)) found.add(name);
    }
    if (process.argv.some(isChromiumArg)) found.add('Chromium');
  }
  return [...childNames, 'Chromium'].filter((name) => found.has(name));
}

function findProcess(name) {
  return getProcesses().find((process) => process.argv.some((arg) => basename(arg) === name));
}

function singletonLockExists() {
  try {
    lstatSync(join(profileDir, 'SingletonLock'));
    return true;
  } catch {
    return false;
  }
}

function reauthTempDirectories() {
  const root = tmpdir();
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('marketplace-reauth-'))
    .map((entry) => join(root, entry.name));
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function waitUntil(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  assert.ok(await check(), message);
}

function postAdmin(port, pathname) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'POST' });
}

function nonLoopbackAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal && entry.address !== '127.0.0.1') {
        return entry.address;
      }
    }
  }
  return undefined;
}

function connectionResult(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(2_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error) => resolve(error.code ?? 'error'));
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
  });
}

function readRfbBanner(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let data = Buffer.alloc(0);
    socket.setTimeout(2_000);
    socket.once('connect', () => {});
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= 12) {
        socket.destroy();
        resolve(data.subarray(0, 12).toString('ascii'));
      }
    });
    socket.once('error', reject);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Timed out waiting for the local RFB banner'));
    });
  });
}

function parseOptionPort(argv, option) {
  const inline = argv.find((arg) => arg.startsWith(`${option}=`));
  const value = inline?.slice(option.length + 1) ?? argv[argv.indexOf(option) + 1];
  const port = Number(value);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535, `Could not find ${option} port in child argv`);
  return port;
}

function loopbackEndpoints(argv) {
  return argv
    .map((arg) => /^(?:127\.0\.0\.1|localhost):(\d+)$/.exec(arg))
    .filter(Boolean)
    .map((match) => Number(match[1]));
}

function assertNoTokenInArgv(token) {
  assert.ok(!getProcesses().some((process) => process.argv.join('\0').includes(token)), 'The VNC password appeared in process argv');
}

function assertTokensNotLogged() {
  const output = `${capturedStdout}\n${capturedStderr}`;
  for (const token of tokens) {
    assert.ok(!output.includes(token), 'A VNC password appeared in service output');
    assert.ok(!output.includes(encodeURIComponent(token)), 'An encoded VNC password appeared in service output');
  }
}

async function adminJson(port, pathname) {
  const response = await postAdmin(port, pathname);
  return { response, body: await response.json() };
}

function decodeProcAddress(hex, ipv6) {
  if (!ipv6) return (hex.match(/../g) ?? []).reverse().map((part) => Number.parseInt(part, 16)).join('.');
  const bytes = (hex.match(/.{8}/g) ?? []).flatMap((group) => (group.match(/../g) ?? []).reverse().map((part) => Number.parseInt(part, 16)));
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return '::1';
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255) {
    return bytes.slice(12).join('.');
  }
  return 'non-loopback-ipv6';
}

function assertNoChromiumNonLoopbackTcpPeer() {
  const chromiumPids = getProcesses()
    .filter((process) => process.argv.some(isChromiumArg))
    .map((process) => process.pid);
  assert.ok(chromiumPids.length > 0, 'No Chromium process was found while checking network peers');
  const ownedSockets = new Set();
  for (const pid of chromiumPids) {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
          const match = /^socket:\[(\d+)\]$/.exec(target);
          if (match) ownedSockets.add(match[1]);
        } catch {
          // Child processes can close descriptors while being inspected.
        }
      }
    } catch {
      // Chromium can exit while the process list is being inspected.
    }
  }

  const peers = [];
  for (const [table, ipv6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
    let lines;
    try {
      lines = readFileSync(table, 'utf8').trim().split('\n').slice(1);
    } catch {
      continue;
    }
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== '01' || !ownedSockets.has(fields[9])) continue;
      const [remoteAddressHex, remotePortHex] = fields[2].split(':');
      peers.push({ address: decodeProcAddress(remoteAddressHex, ipv6), port: Number.parseInt(remotePortHex, 16) });
    }
  }
  const allowedPeers = new Set(['127.0.0.1', '::1']);
  assert.ok(peers.every((peer) => allowedPeers.has(peer.address)), `Chromium has an established non-loopback TCP peer: ${peers.map((peer) => peer.address).join(', ')}`);
}

process.on('exit', () => {
  const orphans = runningChildren();
  const tempDirectories = reauthTempDirectories();
  if (!assertionsPassed || orphans.length > 0 || tempDirectories.length > 0) process.exitCode = 1;
  for (const check of skippedChecks) writeSync(1, `SKIPPED: ${check}\n`);
  writeSync(1, `SMOKE_RESULT ${JSON.stringify({ orphans, tempDirectories })}\n`);
});

const watchdog = setTimeout(() => {
  process.exitCode = 1;
  process.exit(1);
}, 180_000);
watchdog.unref();

async function runSmoke() {
  const requests = [];
  syntheticServer = createServer((request, response) => {
    requests.push({
      host: request.headers.host ?? '',
      remoteAddress: request.socket.remoteAddress ?? '',
      url: request.url ?? ''
    });
    if (request.url !== '/marketplace/') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body><script>document.cookie="reauth-smoke=1; path=/";</script><main>synthetic marketplace</main></body></html>');
  });
  await new Promise((resolve, reject) => {
    syntheticServer.once('error', reject);
    syntheticServer.listen(0, '127.0.0.1', resolve);
  });
  const syntheticAddress = syntheticServer.address();
  assert.ok(syntheticAddress && typeof syntheticAddress === 'object');
  const syntheticHost = `127.0.0.1:${syntheticAddress.port}`;
  const facebookBaseUrl = `http://${syntheticHost}`;
  const reauthTargetUrl = `${facebookBaseUrl}/marketplace/`;

  service = createMarketplaceService({
    host: '127.0.0.1',
    port: 0,
    adminPort: 0,
    facebookBaseUrl,
    reauthTargetUrl,
    reauthLeaseMs: 60_000
  });
  await listen(service);
  installShutdownHandlers(service);

  assert.equal(service.admin.host, '127.0.0.1');
  const adminAddress = service.admin.address();
  assert.ok(adminAddress && typeof adminAddress === 'object');
  assert.equal(adminAddress.address, '127.0.0.1');
  const adminPort = adminAddress.port;
  assert.ok(Number.isInteger(adminPort) && adminPort > 0);
  const containerAddress = nonLoopbackAddress();
  if (containerAddress) {
    assert.equal(await connectionResult(containerAddress, adminPort), 'ECONNREFUSED');
  } else {
    skippedChecks.push('non-loopback admin connection probe (no non-loopback IPv4 address)');
  }

  const started = await adminJson(adminPort, '/reauth/start');
  assert.equal(started.response.status, 200);
  assert.equal(started.body.phase, 'active');
  assert.ok(started.body.lease && typeof started.body.lease.consoleUrl === 'string');
  const consoleUrl = started.body.lease.consoleUrl;
  consoleUrls.push(consoleUrl);
  assert.ok(consoleUrl.startsWith('http://127.0.0.1:'));
  assert.ok(consoleUrl.includes('/vnc.html'));
  assert.ok(consoleUrl.includes('#password='));
  const parsedConsoleUrl = new URL(consoleUrl);
  const token = new URLSearchParams(parsedConsoleUrl.hash.slice(1)).get('password');
  assert.ok(token, 'The viewer URL did not include a password token');
  tokens.push(token);
  assertNoTokenInArgv(token);

  const leaseViewerPort = started.body.lease.viewerPort;
  assert.ok(Number.isInteger(leaseViewerPort) && leaseViewerPort > 0);
  assert.equal(Number(parsedConsoleUrl.port), leaseViewerPort);

  const x11vnc = findProcess('x11vnc');
  const websockify = findProcess('websockify');
  assert.ok(x11vnc, 'x11vnc process was not found');
  assert.ok(websockify, 'websockify process was not found');
  const rfbPort = parseOptionPort(x11vnc.argv, '-rfbport');
  const proxyEndpoints = loopbackEndpoints(websockify.argv);
  assert.equal(proxyEndpoints.length, 2, 'Could not identify websockify listen and RFB target ports');
  assert.equal(proxyEndpoints[0], leaseViewerPort, 'websockify is not listening on the lease viewer port');
  assert.equal(proxyEndpoints[1], rfbPort, 'websockify target does not match x11vnc RFB port');

  await waitUntil(() => ['Xvfb', 'x11vnc', 'websockify', 'Chromium'].every((name) => runningChildren().includes(name)), 'The re-auth display stack did not start');
  await waitUntil(() => requests.some((request) => request.url === '/marketplace/'), 'Chromium did not request the synthetic marketplace page');
  await waitUntil(() => singletonLockExists(), 'Chromium did not create a profile lock');
  assert.ok(requests.every((request) => request.host === syntheticHost), 'The synthetic server received a request for an unexpected host');
  assert.ok(requests.every((request) => request.remoteAddress === '127.0.0.1' || request.remoteAddress === '::ffff:127.0.0.1'), 'The synthetic page was not requested over loopback');
  // This supplemental live TCP sample is not required to observe a connection; it cannot see UDP/DNS or already-closed sockets.
  assertNoChromiumNonLoopbackTcpPeer();

  const rfbBanner = await readRfbBanner(rfbPort);
  assert.match(rfbBanner, /^RFB \d{3}\.\d{3}\n$/);
  const viewerUrl = new URL(consoleUrl);
  viewerUrl.hash = '';
  const viewerResponse = await fetch(viewerUrl);
  assert.equal(viewerResponse.status, 200);
  assert.ok((await viewerResponse.text()).toLowerCase().includes('novnc'));
  assertTokensNotLogged();

  // This proves the configured proxy reaches a live RFB server, but does not perform the complete RFB security/authentication handshake.
  const stopped = await adminJson(adminPort, '/reauth/stop');
  assert.equal(stopped.response.status, 200);
  await waitUntil(() => runningChildren().length === 0, 'Re-auth child processes remained after stop');
  await waitUntil(() => !singletonLockExists(), 'The Chromium profile lock remained after stop');
  await waitUntil(() => reauthTempDirectories().length === 0, 'Re-auth temporary files remained after stop');

  const restarted = await adminJson(adminPort, '/reauth/start');
  assert.equal(restarted.response.status, 200);
  assert.equal(restarted.body.phase, 'active');
  const restartedConsoleUrl = restarted.body.lease?.consoleUrl;
  assert.ok(typeof restartedConsoleUrl === 'string');
  consoleUrls.push(restartedConsoleUrl);
  const restartedToken = new URLSearchParams(new URL(restartedConsoleUrl).hash.slice(1)).get('password');
  assert.ok(restartedToken);
  tokens.push(restartedToken);
  assertNoTokenInArgv(restartedToken);
  await waitUntil(() => ['Xvfb', 'x11vnc', 'websockify', 'Chromium'].every((name) => runningChildren().includes(name)), 'The re-auth display stack did not restart');
  await waitUntil(() => singletonLockExists(), 'Chromium did not recreate its profile lock');
  assertTokensNotLogged();

  const serverClosed = once(service.server, 'close');
  const signalReceived = once(process, 'SIGTERM');
  await closeServer(syntheticServer);
  process.kill(process.pid, 'SIGTERM');
  await signalReceived;
  await serverClosed;
  await waitUntil(() => runningChildren().length === 0, 'Re-auth child processes remained after SIGTERM');
  await waitUntil(() => !singletonLockExists(), 'The Chromium profile lock remained after SIGTERM');
  await waitUntil(() => reauthTempDirectories().length === 0, 'Re-auth temporary files remained after SIGTERM');
  assertTokensNotLogged();
  assert.equal(process.exitCode ?? 0, 0);
  assertionsPassed = true;
}

try {
  await runSmoke();
} catch (error) {
  process.exitCode = 1;
  let diagnostic = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  for (const secret of [...tokens, ...consoleUrls]) {
    if (secret) diagnostic = diagnostic.split(secret).join('[REDACTED]');
  }
  originalStderrWrite(`Re-auth smoke failed:\n${diagnostic}\n`);
  await Promise.allSettled([service?.close(), closeServer(syntheticServer)]);
}
