// EventWatcher: reads events.jsonl incrementally and watches the baselines/ directory.
// Baseline changes come from the hook's Post (new baselines) and from Keep / cleanup in other windows,
// which keeps multiple windows consistent.
import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { Layout } from './paths';

export interface WriteEvent {
  type: 'claude-write';
  path: string;
  tool?: string;
  session?: string;
  prompt?: string;
  agent?: string;
  toolUseId?: string;
  ts: number;
}

export class JsonlTail {
  private offset = 0;
  private partial = '';
  private decoder = new StringDecoder('utf8');

  constructor(private readonly file: string) {}

  readNew<T>(): T[] {
    let fd: number;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch {
      return [];
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < this.offset) {
        // Truncated or rotated: read again from the start; processing is idempotent
        this.offset = 0;
        this.partial = '';
        this.decoder = new StringDecoder('utf8');
      }
      if (size === this.offset) return [];
      const buf = Buffer.alloc(size - this.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      const lines = (this.partial + this.decoder.write(buf.subarray(0, n))).split('\n');
      this.partial = lines.pop() ?? '';
      const out: T[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as T);
        } catch {
          // Skip malformed lines
        }
      }
      return out;
    } finally {
      fs.closeSync(fd);
    }
  }
}

export interface WatcherCallbacks {
  onEvents(events: WriteEvent[]): void;
  onBaselinesChanged(): void;
}

export class StoreWatcher {
  private readonly tail: JsonlTail;
  private watchers: fs.FSWatcher[] = [];
  private poll: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private lastDirStamp = '';
  private disposed = false;

  constructor(
    private readonly L: Layout,
    private readonly cb: WatcherCallbacks,
    private readonly pollMs = 2000,
  ) {
    this.tail = new JsonlTail(L.events);
  }

  start(): void {
    // Drain past events first (to learn which sessions edited each file)
    this.drain();
    const watch = (dir: string) => {
      try {
        const w = fs.watch(dir, { persistent: false }, () => this.schedule());
        w.on('error', () => undefined);
        this.watchers.push(w);
      } catch {
        // Fall back to polling
      }
    };
    watch(this.L.root);
    watch(this.L.baselines);
    // fs.watch occasionally misses events; poll as a safety net
    this.poll = setInterval(() => this.check(), this.pollMs);
  }

  private dirStamp(): string {
    try {
      const d = fs.statSync(this.L.baselines);
      let e = 0;
      try {
        e = fs.statSync(this.L.events).size;
      } catch {
        // No events yet
      }
      return `${d.mtimeMs}:${e}`;
    } catch {
      return '';
    }
  }

  private check(): void {
    if (this.dirStamp() !== this.lastDirStamp) this.schedule();
  }

  private schedule(): void {
    if (this.disposed) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.drain(), 60);
  }

  private drain(): void {
    if (this.disposed) return;
    this.lastDirStamp = this.dirStamp();
    const events = this.tail.readNew<WriteEvent>().filter((e) => e && e.type === 'claude-write' && typeof e.path === 'string');
    if (events.length) this.cb.onEvents(events);
    this.cb.onBaselinesChanged();
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.poll);
    clearTimeout(this.debounce);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}
