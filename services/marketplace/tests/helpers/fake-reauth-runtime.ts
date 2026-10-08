import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import type { ReauthProcessHandle, ReauthRuntime } from '../../src/reauth.js';

export class FakeReauthRuntime implements ReauthRuntime {
  readonly providesDisplay = false;
  readonly children: ChildProcess[] = [];
  delayDisplay: Promise<void> | undefined;
  onStartDisplay: (() => void) | undefined;
  startedHandles: ReauthProcessHandle[] = [];
  passwordFile: string | undefined;
  lastHandle: ReauthProcessHandle | undefined;
  blockViewer = false;
  failVnc = false;
  failViewer = false;
  throwOnUnsubscribe = false;
  private releaseViewer: (() => void) | undefined;

  async startDisplay(): Promise<{ handle: ReauthProcessHandle; display: string }> {
    this.onStartDisplay?.();
    if (this.delayDisplay) await this.delayDisplay;
    return { handle: this.spawn('fake-display'), display: ':0' };
  }

  async startVnc(_input: { display: string; port: number; passwordFile: string }): Promise<ReauthProcessHandle> {
    this.passwordFile = _input.passwordFile;
    if (this.failVnc) throw new Error('synthetic VNC startup failure');
    return this.spawn('fake-vnc');
  }

  async startViewer(_input: { port: number; rfbPort: number }): Promise<ReauthProcessHandle> {
    if (this.failViewer) throw new Error('synthetic viewer startup failure');
    if (this.blockViewer) await new Promise<void>((resolve) => { this.releaseViewer = resolve; });
    return this.spawn('fake-viewer');
  }

  unblockViewer(): void {
    this.releaseViewer?.();
    this.releaseViewer = undefined;
  }

  kill(handle: ReauthProcessHandle | undefined = this.lastHandle): void {
    const child = this.children.find((candidate) => candidate.pid === handle?.pid);
    child?.kill('SIGKILL');
  }

  async allocatePort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    const port = address.port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }));
  }

  private spawn(label: string): ReauthProcessHandle {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    this.children.push(child);
    let stopped: Promise<void> | undefined;
    const listeners = new Set<() => void>();
    let exited = child.exitCode !== null || child.signalCode !== null;
    child.once('exit', () => {
      exited = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    });
    const handle: ReauthProcessHandle = {
      label,
      pid: child.pid,
      onExit: (listener) => {
        if (exited) {
          queueMicrotask(listener);
          return () => undefined;
        }
        listeners.add(listener);
        return () => {
          if (this.throwOnUnsubscribe) throw new Error('synthetic unsubscribe failure');
          listeners.delete(listener);
        };
      },
      stop: () => {
        if (stopped) return stopped;
        stopped = new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          }, 2_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill('SIGTERM');
        });
        return stopped;
      }
    };
    this.startedHandles.push(handle);
    this.lastHandle = handle;
    return handle;
  }
}
