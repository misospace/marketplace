import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';

const fixtureNames = [
  'results-normal.html', 'results-multi-currency.html', 'results-vehicle.html', 'results-sponsored.html',
  'results-missing-price.html', 'results-sold-pending.html', 'results-duplicate.html', 'results-malformed.html',
  'results-all-malformed.html', 'no-results.html', 'layout-changed.html', 'login.html', 'checkpoint.html',
  'captcha.html', 'rate-limited.html'
] as const;
export type FixtureName = typeof fixtureNames[number];
const fixtures = new Map<FixtureName, string>(fixtureNames.map((name) => [
  name,
  readFileSync(new URL(`../fixtures/facebook-marketplace/${name}`, import.meta.url), 'utf8')
]));

export type SyntheticServer = {
  server: Server;
  origin: string;
  requests: string[];
  configure(probeFile: FixtureName, searchFile: FixtureName, hangSearch?: boolean, probeHtml?: string): void;
  configureItem(fixtureFile: string, hang?: boolean): void;
  close(): Promise<void>;
};

let activeSynthetic: SyntheticServer | undefined;

export async function startSyntheticServer(): Promise<SyntheticServer> {
  const requests: string[] = [];
  let probeFile: FixtureName = 'results-normal.html';
  let probeHtml: string | undefined;
  let searchFile: FixtureName = 'results-normal.html';
  let hangSearch = false;
  let itemHtml: string | undefined;
  let hangItem = false;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(request.url ?? pathname);
    if (hangSearch && /^\/marketplace\/[^/]+\/search\/$/.test(pathname)) return;
    if (hangItem && /^\/marketplace\/item\/[^/]+\/$/.test(pathname)) return;
    let fixture: string | undefined;
    if (pathname === '/marketplace/') fixture = probeHtml ?? fixtures.get(probeFile);
    else if (/^\/marketplace\/[^/]+\/search\/$/.test(pathname)) fixture = fixtures.get(searchFile);
    else if (/^\/marketplace\/item\/[^/]+\/$/.test(pathname)) fixture = itemHtml;
    if (!fixture) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('missing synthetic route');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(fixture);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  const synthetic: SyntheticServer = {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    configure: (nextProbeFile, nextSearchFile, nextHangSearch = false, nextProbeHtml) => {
      probeFile = nextProbeFile;
      probeHtml = nextProbeHtml;
      searchFile = nextSearchFile;
      hangSearch = nextHangSearch;
      requests.length = 0;
    },
    configureItem: (fixtureFile, nextHang = false) => {
      itemHtml = readFileSync(new URL(`../fixtures/facebook-marketplace/${fixtureFile}`, import.meta.url), 'utf8');
      hangItem = nextHang;
      requests.length = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
  activeSynthetic = synthetic;
  return synthetic;
}

export function waitForRequest(pathPrefix: string): Promise<void> {
  if (!activeSynthetic) return Promise.reject(new Error('Synthetic server has not started'));
  if (activeSynthetic.requests.some((request) => request.startsWith(pathPrefix))) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for synthetic request ${pathPrefix}`));
    }, 5_000);
    const poll = setInterval(() => {
      if (activeSynthetic?.requests.some((request) => request.startsWith(pathPrefix))) {
        clearTimeout(timeout);
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });
}
