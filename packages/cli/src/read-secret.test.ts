// readSecret masks API-key input — including PASTED input, the bug the old
// readline `_writeToOutput` override left exposed. Raw mode disables the
// terminal's own echo, so nothing typed or pasted reaches the screen. Driven
// through injectable fake TTY / pipe streams (no real terminal).

import { describe, expect, it } from 'vitest';

import { type SecretInput, readSecret } from './munin-setup';

class FakeTTY implements SecretInput {
  readonly isTTY = true;
  isRaw: boolean;
  readonly rawCalls: boolean[] = [];
  paused = false;
  resumed = false;
  private listeners: Array<(c: string) => void> = [];
  constructor(startRaw = false) {
    this.isRaw = startRaw;
  }
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawCalls.push(mode);
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    this.resumed = true;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
  on(_e: 'data', l: (c: string) => void): this {
    this.listeners.push(l);
    return this;
  }
  removeListener(_e: 'data', l: (c: string) => void): this {
    this.listeners = this.listeners.filter((x) => x !== l);
    return this;
  }
  /** Simulate the terminal delivering input (one chunk = one paste/keystroke run). */
  emit(chunk: string): void {
    for (const l of [...this.listeners]) l(chunk);
  }
  get listenerCount(): number {
    return this.listeners.length;
  }
}

// A non-TTY stdin: no setRawMode at all, so readSecret takes the plain-line path.
class FakePipe implements SecretInput {
  readonly isTTY = false;
  private listeners: Array<(c: string) => void> = [];
  setEncoding(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  on(_e: 'data', l: (c: string) => void): this {
    this.listeners.push(l);
    return this;
  }
  removeListener(_e: 'data', l: (c: string) => void): this {
    this.listeners = this.listeners.filter((x) => x !== l);
    return this;
  }
  emit(chunk: string): void {
    for (const l of [...this.listeners]) l(chunk);
  }
}

function makeOutput() {
  const writes: string[] = [];
  return {
    output: {
      write(chunk: string): boolean {
        writes.push(chunk);
        return true;
      },
    },
    all: (): string => writes.join(''),
  };
}

describe('readSecret (TTY raw-mode masking)', () => {
  it('masks a PASTED key — the secret never reaches the output or scrollback', async () => {
    const input = new FakeTTY();
    const { output, all } = makeOutput();
    const SECRET = 'pasted-fake-key-1234567890';
    const p = readSecret('Paste your key: ', { input, output });
    // A paste arrives as one chunk of many chars, terminated by Enter.
    input.emit(`${SECRET}\r`);
    expect(await p).toBe(SECRET);
    expect(all()).toContain('Paste your key: '); // the prompt shows
    expect(all()).not.toContain(SECRET); // the key does NOT — masked
  });

  it('engages raw mode, restores the prior raw state, and stops reading', async () => {
    const input = new FakeTTY(false);
    const { output } = makeOutput();
    const p = readSecret('Key: ', { input, output });
    input.emit('abc\n');
    await p;
    expect(input.rawCalls[0]).toBe(true); // raw mode turned ON to suppress echo
    expect(input.rawCalls.at(-1)).toBe(false); // restored to the prior state
    expect(input.isRaw).toBe(false);
    expect(input.paused).toBe(true); // stdin released
    expect(input.listenerCount).toBe(0); // no dangling 'data' handler
  });

  it('restores a PREVIOUSLY-raw terminal back to raw (not blindly to cooked)', async () => {
    const input = new FakeTTY(true);
    const { output } = makeOutput();
    const p = readSecret('Key: ', { input, output });
    input.emit('x\n');
    await p;
    expect(input.rawCalls.at(-1)).toBe(true); // restored to the prior raw=true
  });

  it('accumulates typed chunks and honours backspace, masking throughout', async () => {
    const input = new FakeTTY();
    const { output, all } = makeOutput();
    const p = readSecret('Key: ', { input, output });
    input.emit('XY'); // buf: XY
    input.emit('\u007f'); // DEL → buf: X
    input.emit('Z9\r'); // buf: XZ9, then Enter
    expect(await p).toBe('XZ9');
    expect(all()).not.toContain('XZ9');
  });

  it('rejects on Ctrl-C and still restores the terminal', async () => {
    const input = new FakeTTY();
    const { output } = makeOutput();
    const p = readSecret('Key: ', { input, output });
    input.emit('\u0003');
    await expect(p).rejects.toThrow(/cancel/i);
    expect(input.rawCalls.at(-1)).toBe(false);
    expect(input.paused).toBe(true);
  });

  it('reads a plain line on non-TTY stdin (piped input, CI)', async () => {
    const input = new FakePipe();
    const { output, all } = makeOutput();
    const p = readSecret('Key: ', { input, output });
    input.emit('piped-key\n');
    expect(await p).toBe('piped-key');
    expect(all()).toContain('Key: ');
  });
});
