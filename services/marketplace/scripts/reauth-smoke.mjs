import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeSync } from 'node:fs';
import { once } from 'node:events';
import { basename, join, resolve } from 'node:path';
import { networkInterfaces, tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createCipheriv } from 'node:crypto';
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

function reverseBits(value) {
  let reversed = 0;
  for (let bit = 0; bit < 8; bit += 1) reversed |= ((value >> bit) & 1) << (7 - bit);
  return reversed;
}

function vncAuthResponse(password, challenge) {
  const key = Buffer.alloc(8);
  for (let index = 0; index < Math.min(password.length, key.length); index += 1) {
    key[index] = reverseBits(password.charCodeAt(index) & 0xff);
  }
  const cipher = createCipheriv('des-ede3-ecb', Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

class WebSocketByteReader {
  constructor(url) {
    assert.equal(typeof WebSocket, 'function', 'Node does not provide the built-in WebSocket API');
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.buffer = Buffer.alloc(0);
    this.waiters = new Set();
    this.failure = null;
    this.closed = false;
    this.opened = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out opening the local RFB WebSocket')), 5_000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Could not open the local RFB WebSocket'));
      }, { once: true });
      this.socket.addEventListener('close', () => {
        clearTimeout(timeout);
        reject(new Error('The local RFB WebSocket closed before opening'));
      }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const data = event.data;
      if (data instanceof ArrayBuffer) this.buffer = Buffer.concat([this.buffer, Buffer.from(data)]);
      else if (ArrayBuffer.isView(data)) this.buffer = Buffer.concat([this.buffer, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]);
      else {
        this.failure = new Error('The RFB WebSocket returned a non-binary message');
      }
      this.notify();
    });
    this.socket.addEventListener('error', () => {
      this.failure = new Error('The local RFB WebSocket failed');
      this.notify();
    });
    this.socket.addEventListener('close', () => {
      this.closed = true;
      this.notify();
    });
  }

  notify() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  async open() {
    await this.opened;
  }

  send(data) {
    this.socket.send(data);
  }

  async readExactly(size, timeoutMs = 10_000) {
    assert.ok(Number.isInteger(size) && size >= 0);
    const deadline = Date.now() + timeoutMs;
    while (this.buffer.length < size) {
      if (this.failure) throw this.failure;
      if (this.closed) throw new Error('The RFB WebSocket closed before the response was complete');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Timed out reading the RFB WebSocket response');
      await new Promise((resolve, reject) => {
        const wake = () => {
          clearTimeout(timeout);
          this.waiters.delete(wake);
          resolve();
        };
        const timeout = setTimeout(() => {
          this.waiters.delete(wake);
          reject(new Error('Timed out reading the RFB WebSocket response'));
        }, remaining);
        this.waiters.add(wake);
      });
    }
    const result = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return result;
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
  }
}

async function readFramebufferUpdate(connection, width, height, bytesPerPixel) {
  const request = Buffer.alloc(10);
  request[0] = 3;
  request.writeUInt16BE(width, 6);
  request.writeUInt16BE(height, 8);
  connection.send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    connection.send(request);
    while (true) {
      const messageType = (await connection.readExactly(1))[0];
      if (messageType === 0) {
        await connection.readExactly(1);
        const rectangleCount = (await connection.readExactly(2)).readUInt16BE(0);
        for (let index = 0; index < rectangleCount; index += 1) {
          const rectangle = await connection.readExactly(12);
          const x = rectangle.readUInt16BE(0);
          const y = rectangle.readUInt16BE(2);
          const rectangleWidth = rectangle.readUInt16BE(4);
          const rectangleHeight = rectangle.readUInt16BE(6);
          const encoding = rectangle.readInt32BE(8);
          assert.ok(x + rectangleWidth <= width && y + rectangleHeight <= height, 'RFB update rectangle exceeded the framebuffer');
          if (rectangleWidth === 0 || rectangleHeight === 0) continue;
          assert.equal(encoding, 0, 'The RFB server did not honor the requested raw framebuffer encoding');
          await connection.readExactly(rectangleWidth * rectangleHeight * bytesPerPixel, 30_000);
          return { width: rectangleWidth, height: rectangleHeight };
        }
        break;
      }
      if (messageType === 1) {
        await connection.readExactly(3);
        const colors = (await connection.readExactly(2)).readUInt16BE(0);
        await connection.readExactly(colors * 6);
      } else if (messageType === 2) {
        // Bell has no payload.
      } else if (messageType === 3) {
        await connection.readExactly(3);
        const length = (await connection.readExactly(4)).readUInt32BE(0);
        await connection.readExactly(length);
      } else {
        assert.fail(`Unexpected RFB server message type ${messageType}`);
      }
    }
  }
  assert.fail('The RFB server did not send a framebuffer rectangle with non-zero area');
}

async function rfbHandshake(viewerPort, password, expectFramebuffer) {
  const connection = new WebSocketByteReader(`ws://127.0.0.1:${viewerPort}/websockify`);
  try {
    await connection.open();
    const banner = await connection.readExactly(12);
    assert.equal(banner.toString('ascii'), 'RFB 003.008\n');
    connection.send(Buffer.from('RFB 003.008\n', 'ascii'));

    const securityTypeCount = (await connection.readExactly(1))[0];
    assert.ok(securityTypeCount > 0, 'The RFB server offered no security types');
    const securityTypes = await connection.readExactly(securityTypeCount);
    assert.ok(securityTypes.includes(2), 'The RFB server did not offer VNC authentication');
    connection.send(Buffer.from([2]));

    const challenge = await connection.readExactly(16);
    connection.send(vncAuthResponse(password, challenge));
    const securityResult = (await connection.readExactly(4)).readUInt32BE(0);
    if (!expectFramebuffer) return securityResult;

    assert.equal(securityResult, 0, 'The console URL token did not authenticate with the RFB server');
    connection.send(Buffer.from([1]));
    const serverInit = await connection.readExactly(24);
    const width = serverInit.readUInt16BE(0);
    const height = serverInit.readUInt16BE(2);
    const bitsPerPixel = serverInit[4];
    assert.equal(width, 1280, 'The RFB framebuffer width did not match Xvfb');
    assert.equal(height, 1024, 'The RFB framebuffer height did not match Xvfb');
    assert.ok([8, 16, 32].includes(bitsPerPixel), 'The RFB framebuffer used an unsupported pixel size');
    const nameLength = serverInit.readUInt32BE(20);
    await connection.readExactly(nameLength);

    const rectangle = await readFramebufferUpdate(connection, width, height, bitsPerPixel / 8);
    assert.ok(rectangle.width > 0 && rectangle.height > 0, 'The RFB update contained no non-empty rectangle');
    return securityResult;
  } finally {
    connection.close();
  }
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
  assert.match(viewerResponse.headers.get('content-type') ?? '', /^text\/html\b/i);
  assert.ok((await viewerResponse.text()).length > 0, 'The viewer page was empty');

  assert.equal(await rfbHandshake(leaseViewerPort, token, true), 0);
  const wrongPasswordResult = await rfbHandshake(leaseViewerPort, 'notright', false);
  assert.notEqual(wrongPasswordResult, 0, 'The RFB server accepted an incorrect password');
  writeSync(1, 'RFB negative control: rejected incorrect password\n');
  assertTokensNotLogged();

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
