// `munin add` — unit tests. The orchestration (`runAdd`) is driven with a STUB
// picker; `pickFolder`'s osascript exit/stderr parsing is driven with a MOCKED
// `node:child_process` (a fake EventEmitter child). Neither path opens the real
// GUI dialog — `osascript` is replaced entirely by the mock.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AddDeps,
  CANCELLED_MESSAGE,
  PICKER_UNAVAILABLE_MESSAGE,
  PickerUnavailableError,
  pickFolder,
  runAdd,
} from './munin-add';

// Replace `osascript` spawning entirely — every pickFolder test drives a fake
// child, so no dialog is ever opened (even on a macOS host).
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

/** Build AddDeps with a scripted picker and spies for ingest/log/logError. */
function makeDeps(picker: () => Promise<string | null>): {
  deps: AddDeps;
  ingest: ReturnType<typeof vi.fn>;
  logs: string[];
  errors: string[];
} {
  const ingest = vi.fn(async (_argv: readonly string[]) => {});
  const logs: string[] = [];
  const errors: string[] = [];
  const deps: AddDeps = {
    pickFolder: picker,
    ingest,
    log: (l) => logs.push(l),
    logError: (l) => errors.push(l),
  };
  return { deps, ingest, logs, errors };
}

describe('runAdd', () => {
  it('picked folder → ingests that path with the forwarded defaults', async () => {
    const { deps, ingest, logs } = makeDeps(async () => '/Users/me/Docs');
    const forwarded = ['--tenant', 't-1', '--tags', 'personal'];

    const result = await runAdd(forwarded, deps);

    expect(result).toEqual({ outcome: 'ingested', exitCode: 0 });
    // The picked path is prepended as the directory; the defaults carry through.
    expect(ingest).toHaveBeenCalledExactlyOnceWith([
      '/Users/me/Docs',
      '--tenant',
      't-1',
      '--tags',
      'personal',
    ]);
    expect(logs.some((l) => l.includes('/Users/me/Docs'))).toBe(true);
  });

  it('user cancels → no ingest, clean exit, "nothing added" message', async () => {
    const { deps, ingest, logs } = makeDeps(async () => null);

    const result = await runAdd(['--tags', 'personal'], deps);

    expect(result).toEqual({ outcome: 'cancelled', exitCode: 0 });
    expect(ingest).not.toHaveBeenCalled();
    expect(logs).toContain(CANCELLED_MESSAGE);
  });

  it('picker unavailable (non-macOS / spawn failure) → fallback message, non-zero, no ingest', async () => {
    const { deps, ingest, errors } = makeDeps(async () => {
      throw new PickerUnavailableError('not macOS');
    });

    const result = await runAdd(['--tags', 'personal'], deps);

    expect(result.outcome).toBe('picker-unavailable');
    expect(result.exitCode).not.toBe(0);
    expect(ingest).not.toHaveBeenCalled();
    expect(errors).toContain(PICKER_UNAVAILABLE_MESSAGE);
  });

  it('a non-picker error (e.g. the store lock) propagates untouched', async () => {
    // runIngest's lock pre-flight throws LocalStoreLockedError; `add` must NOT
    // swallow it — it propagates to the dispatcher's friendly handler.
    const lockErr = new Error('local store locked');
    const { deps, ingest } = makeDeps(async () => {
      throw lockErr;
    });

    await expect(runAdd([], deps)).rejects.toBe(lockErr);
    expect(ingest).not.toHaveBeenCalled();
  });
});

// A fake ChildProcess: an EventEmitter with stdout/stderr EventEmitters, enough
// for pickFolder's listeners. The test emits data/close/error to drive a branch.
function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('pickFolder', () => {
  const realPlatform = process.platform;
  const mockedSpawn = vi.mocked(spawn);

  function setPlatform(value: string): void {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  beforeEach(() => {
    mockedSpawn.mockReset();
  });
  afterEach(() => {
    setPlatform(realPlatform);
  });

  it('off macOS rejects PickerUnavailableError without spawning anything', async () => {
    setPlatform('linux');
    await expect(pickFolder()).rejects.toBeInstanceOf(PickerUnavailableError);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('exit 0 with a path resolves the trimmed POSIX path', async () => {
    setPlatform('darwin');
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const p = pickFolder();
    child.stdout.emit('data', '/Users/me/Docs\n');
    child.emit('close', 0);
    await expect(p).resolves.toBe('/Users/me/Docs');
  });

  it('exit 0 with empty stdout resolves null (defensive cancel)', async () => {
    setPlatform('darwin');
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const p = pickFolder();
    child.emit('close', 0);
    await expect(p).resolves.toBeNull();
  });

  it('cancel via the -128 code resolves null (exit 0 contract)', async () => {
    setPlatform('darwin');
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const p = pickFolder();
    child.stderr.emit('data', 'execution error: User cancelled. (-128)');
    child.emit('close', 1);
    await expect(p).resolves.toBeNull();
  });

  it('cancel via the localized text (no -128) still resolves null', async () => {
    // Guards the spelling fix: macOS emits "cancelled"; the regex must match it.
    setPlatform('darwin');
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const p = pickFolder();
    child.stderr.emit('data', 'execution error: User cancelled.');
    child.emit('close', 1);
    await expect(p).resolves.toBeNull();
  });

  it('any other non-zero exit rejects PickerUnavailableError (fall back to ingest)', async () => {
    setPlatform('darwin');
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const p = pickFolder();
    child.stderr.emit('data', 'some unexpected osascript failure');
    child.emit('close', 1);
    await expect(p).rejects.toBeInstanceOf(PickerUnavailableError);
  });

  it('a spawn error (osascript not on PATH) rejects PickerUnavailableError', async () => {
    setPlatform('darwin');
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const p = pickFolder();
    child.emit('error', new Error('spawn osascript ENOENT'));
    await expect(p).rejects.toBeInstanceOf(PickerUnavailableError);
  });
});
