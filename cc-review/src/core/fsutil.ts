import * as fs from 'node:fs';

let seq = 0;
function tmpName(file: string): string {
  return `${file}.${process.pid}.${Date.now().toString(36)}.${(seq++).toString(36)}.tmp`;
}

/** Write to a .tmp file, then rename, so a crash never leaves a half-written file. */
export function writeAtomic(file: string, data: string | Uint8Array): void {
  const tmp = tmpName(file);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    rmQuiet(tmp);
    throw e;
  }
}

export function copyAtomic(src: string, dst: string): void {
  const tmp = tmpName(dst);
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
  } catch (e) {
    rmQuiet(tmp);
    throw e;
  }
}

export function rmQuiet(p: string): void {
  try {
    fs.rmSync(p, { force: true, recursive: true });
  } catch {
    // Ignore
  }
}

export function readJsonQuiet<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function readQuiet(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
}

export function appendJsonLine(file: string, obj: unknown): void {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

export function readJsonLines<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip a partially written line
    }
  }
  return out;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

/**
 * Cross-process mutex; mkdir is atomic. The hook's Post and the extension's baseline deletion both
 * take this lock, so "the extension sees equal content and deletes the baseline" cannot interleave
 * with "Claude just wrote and Post is about to check the baseline". If the lock cannot be acquired
 * in time, run anyway: a tiny chance of a race beats stalling Claude Code.
 */
export function withLock<T>(dir: string, fn: () => T, timeoutMs = 2000, staleMs = 10_000): T {
  const start = Date.now();
  let acquired = false;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      acquired = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > staleMs) {
          fs.rmdirSync(dir);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) break;
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // Ignore
      }
    }
  }
}
