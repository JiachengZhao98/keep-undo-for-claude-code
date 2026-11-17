// Measures what the window under test actually does while a scenario runs: frame times and long
// tasks on its main thread (over the Chrome DevTools Protocol), stalls of the extension host's event
// loop, and screenshots. Needs VS Code started with --remote-debugging-port (CCR_PERF=1 in run.mjs).
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function getJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(e as Error);
          }
        });
      })
      .on('error', reject);
  });
}

export interface FrameStats {
  frames: number;
  /** Median and 95th percentile frame interval in ms */
  p50: number;
  p95: number;
  max: number;
  /** Frames longer than 50 ms (three dropped frames at 60 Hz) and 100 ms */
  over50: number;
  over100: number;
  /** Main-thread tasks longer than 50 ms: how many, the longest, and their total */
  longTasks: number;
  longestTask: number;
  longTaskTotal: number;
}

/** Installed in the workbench page: records requestAnimationFrame intervals and long tasks while `on` */
const RECORDER = `(() => {
  if (window.__ccr) return true;
  const s = (window.__ccr = { frames: [], tasks: [], on: false, last: 0 });
  const tick = (t) => {
    if (s.on && s.last) s.frames.push(Math.round((t - s.last) * 10) / 10);
    s.last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  new PerformanceObserver((list) => {
    if (s.on) for (const e of list.getEntries()) s.tasks.push(Math.round(e.duration));
  }).observe({ entryTypes: ['longtask'] });
  return true;
})()`;

export class Probe {
  private id = 0;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private shots = 0;

  private constructor(
    private readonly ws: WebSocket,
    private readonly port: number,
    private readonly shotDir: string | undefined,
  ) {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === undefined) return;
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
    });
  }

  /** Connect to the workbench page of the VS Code instance listening on `port` */
  static async connect(port: number, shotDir?: string): Promise<Probe> {
    const targets = await getJson<Target[]>(`http://127.0.0.1:${port}/json/list`);
    const page = targets.find((t) => t.type === 'page' && /workbench/.test(t.url) && t.webSocketDebuggerUrl);
    if (!page) throw new Error(`No workbench page among ${targets.length} debug targets`);
    const ws = new WebSocket(page.webSocketDebuggerUrl!);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('Could not connect to the debug port')));
    });
    if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
    const probe = new Probe(ws, port, shotDir);
    await probe.evaluate(RECORDER);
    return probe;
  }

  send<T>(method: string, params: object = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }

  async start(): Promise<void> {
    await this.evaluate('(() => { const s = window.__ccr; s.frames = []; s.tasks = []; s.last = 0; s.on = true; })()');
  }

  async stop(): Promise<FrameStats> {
    const raw = await this.evaluate<string>('(() => { const s = window.__ccr; s.on = false; return JSON.stringify({ frames: s.frames, tasks: s.tasks }); })()');
    const { frames, tasks } = JSON.parse(raw) as { frames: number[]; tasks: number[] };
    const sorted = [...frames].sort((a, b) => a - b);
    const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
    return {
      frames: frames.length,
      p50: at(0.5),
      p95: at(0.95),
      max: sorted.at(-1) ?? 0,
      over50: frames.filter((f) => f > 50).length,
      over100: frames.filter((f) => f > 100).length,
      longTasks: tasks.length,
      longestTask: Math.max(0, ...tasks),
      longTaskTotal: tasks.reduce((a, b) => a + b, 0),
    };
  }

  /** Webview frames alive in this VS Code instance (each is a process of its own) */
  async webviews(): Promise<number> {
    const targets = await getJson<Target[]>(`http://127.0.0.1:${this.port}/json/list`);
    return targets.filter((t) => t.type === 'iframe' && t.url.startsWith('vscode-webview://')).length;
  }

  /** Save a screenshot of the window as <shotDir>/<nn>-<name>.jpg; a no-op without a screenshot directory */
  async shot(name: string): Promise<void> {
    if (!this.shotDir) return;
    const r = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 55 });
    fs.writeFileSync(path.join(this.shotDir, `${String(++this.shots).padStart(2, '0')}-${name}.jpg`), Buffer.from(r.data, 'base64'));
  }

  close(): void {
    this.ws.close();
  }
}

/** The longest stall of this process's event loop between start and the returned function's call, in ms */
export function watchEventLoop(): () => number {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  return () => {
    clearInterval(timer);
    return Math.round(worst);
  };
}

export function formatFrames(f: FrameStats): string {
  return `${f.frames} frames, median ${f.p50}ms, p95 ${f.p95}ms, max ${Math.round(f.max)}ms, ${f.over50} over 50ms (${f.over100} over 100ms); long tasks ${f.longTasks}, longest ${f.longestTask}ms, total ${f.longTaskTotal}ms`;
}
