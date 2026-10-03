// Reading and writing ~/.cc-review (extension side).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendJsonLine, readJsonLines, readJsonQuiet, readQuiet, rmQuiet, withLock, writeAtomic } from './fsutil';
import { DEFAULT_IGNORE } from './ignore';
import { baseFile, ensureLayout, lockDir, metaFile, pathKey, type Layout } from './paths';
import type { RevertLine } from './reverts';
import { contentEqual } from './text';

export interface BaselineMeta {
  path: string;
  /** false = a file Claude created */
  existed: boolean;
  ts: number;
  sessions?: string[];
}

export interface Baseline {
  key: string;
  meta: BaselineMeta;
  /** Empty Buffer when existed is false */
  content: Buffer;
}

const DAY = 24 * 3600_000;

export class Store {
  constructor(readonly L: Layout) {}

  ensure(): void {
    ensureLayout(this.L);
    if (!fs.existsSync(this.L.ignoreFile)) writeAtomic(this.L.ignoreFile, DEFAULT_IGNORE);
  }

  keys(): string[] {
    try {
      return fs
        .readdirSync(this.L.baselines)
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -5));
    } catch {
      return [];
    }
  }

  /** Modification times of the metadata and content, to detect whether another window or the hook changed this baseline */
  stamp(key: string): string | undefined {
    try {
      const m = fs.statSync(metaFile(this.L, key));
      let b = 0;
      try {
        b = fs.statSync(baseFile(this.L, key)).mtimeMs;
      } catch {
        // New files have no .base
      }
      return `${m.mtimeMs}:${m.size}:${b}`;
    } catch {
      return undefined;
    }
  }

  read(key: string): Baseline | undefined {
    const meta = readJsonQuiet<BaselineMeta>(metaFile(this.L, key));
    if (!meta || typeof meta.path !== 'string') return undefined;
    if (!meta.existed) return { key, meta, content: Buffer.alloc(0) };
    const content = readQuiet(baseFile(this.L, key));
    return content ? { key, meta, content } : undefined;
  }

  readByPath(p: string): Baseline | undefined {
    return this.read(pathKey(p));
  }

  write(meta: BaselineMeta, content: Buffer): void {
    const key = pathKey(meta.path);
    withLock(lockDir(this.L, key), () => {
      if (meta.existed) writeAtomic(baseFile(this.L, key), content);
      else rmQuiet(baseFile(this.L, key));
      writeAtomic(metaFile(this.L, key), JSON.stringify(meta));
    });
  }

  delete(key: string): void {
    withLock(lockDir(this.L, key), () => this.deleteUnlocked(key));
  }

  private deleteUnlocked(key: string): void {
    rmQuiet(metaFile(this.L, key)); // Delete the metadata first: readers treat it as the source of truth
    rmQuiet(baseFile(this.L, key));
  }

  /**
   * Delete the baseline if it matches the content on disk; returns whether it was deleted. Both sides
   * are re-read under the lock, so a baseline the hook just relied on is never deleted by mistake.
   * Unsaved edits in an editor do not count: the disk decides.
   */
  deleteIfDiskMatches(key: string): boolean {
    return withLock(lockDir(this.L, key), () => {
      const b = this.read(key);
      if (!b) return false;
      const disk = readQuiet(b.meta.path);
      const equal = b.meta.existed ? !!disk && contentEqual(b.content, disk) : !disk;
      if (equal) this.deleteUnlocked(key);
      return equal;
    });
  }

  appendRevert(line: RevertLine): void {
    appendJsonLine(this.L.reverts, line);
  }

  readReverts(): RevertLine[] {
    return readJsonLines<RevertLine>(this.L.reverts);
  }

  /** Startup cleanup: expired staging files, baselines older than 30 days, oversized event and revert logs. */
  gc(now = Date.now()): { removedBaselines: string[] } {
    const removedBaselines: string[] = [];
    const sweep = (dir: string, ttl: number) => {
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names) {
        const f = path.join(dir, n);
        try {
          if (now - fs.statSync(f).mtimeMs > ttl) rmQuiet(f);
        } catch {
          // Deleted concurrently
        }
      }
    };
    sweep(this.L.staging, DAY);
    sweep(this.L.reported, 30 * DAY);
    for (const key of this.keys()) {
      const meta = readJsonQuiet<BaselineMeta>(metaFile(this.L, key));
      if (!meta || now - meta.ts > 30 * DAY) {
        this.delete(key);
        removedBaselines.push(key);
      }
    }
    // Orphaned .base / .tmp files and stale locks
    try {
      for (const n of fs.readdirSync(this.L.baselines)) {
        const f = path.join(this.L.baselines, n);
        const stale = (() => {
          try {
            return now - fs.statSync(f).mtimeMs > 3600_000;
          } catch {
            return false;
          }
        })();
        if (!stale) continue;
        if (n.endsWith('.tmp') || n.endsWith('.lock')) rmQuiet(f);
        else if (n.endsWith('.base') && !fs.existsSync(path.join(this.L.baselines, n.slice(0, -5) + '.json'))) rmQuiet(f);
      }
    } catch {
      // The directory does not exist
    }
    this.trimLog(this.L.events, 5 * 1024 * 1024, 2000);
    this.trimLog(this.L.reverts, 2 * 1024 * 1024, 1000);
    return { removedBaselines };
  }

  private trimLog(file: string, maxBytes: number, keepLines: number): void {
    try {
      if (fs.statSync(file).size <= maxBytes) return;
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      writeAtomic(file, lines.slice(-keepLines).join('\n') + '\n');
    } catch {
      // Does not exist
    }
  }
}
