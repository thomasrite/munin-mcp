// `munin add` — pick a folder with the NATIVE macOS chooser and ingest it.
//
// The whole point is to take the shell OUT of file selection: the dogfooding
// user lost time to zsh quoting and leading/trailing-space ENOENTs typing paths
// into `munin ingest`. A native picker returns a clean POSIX path structurally,
// so that entire failure class disappears. The command is a thin CLI-tier wrapper
// over the existing `runIngest` — no engine change, no re-implemented ingest, so
// it inherits `runIngest`'s path/lock pre-flights, default `personal` tag, and
// tenant resolution untouched.
//
// The OS glue lives behind `pickFolder()` so the orchestration (`runAdd`) is
// unit-testable with a stub picker; the GUI dialog itself is not tested.

import { spawn } from 'node:child_process';

// The folder chooser is unavailable here: not macOS, or `osascript` could not be
// spawned. The caller maps this to the "use `munin ingest` instead" fallback —
// it is a missing-mechanism signal, NOT a user cancel (cancel resolves to null).
export class PickerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PickerUnavailableError';
  }
}

// Quote-free on purpose: it is interpolated into an AppleScript double-quoted
// string, so keeping it free of `"` avoids any escaping.
const FOLDER_PROMPT = 'Choose a folder to add to your Munin memory';

/**
 * Open the native macOS folder chooser and resolve to the picked POSIX path.
 * Returns null when the user cancels (AppleScript error -128 — a clean "no
 * selection"). Rejects with PickerUnavailableError when the mechanism is absent
 * (not macOS, `osascript` un-spawnable, or any other non-cancel failure) so the
 * caller can fall back to `munin ingest`. The GUI makes this untestable directly;
 * `runAdd` is exercised with a stub picker instead.
 */
export function pickFolder(): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return Promise.reject(
      new PickerUnavailableError(`folder picker is macOS-only (on ${process.platform})`),
    );
  }
  return new Promise((resolve, reject) => {
    // `POSIX path of (choose folder …)` prints a clean /Users/… path to stdout.
    const script = `POSIX path of (choose folder with prompt "${FOLDER_PROMPT}")`;
    const child = spawn('osascript', ['-e', script]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    // Spawn failure (e.g. `osascript` not on PATH) — same fallback as not-macOS.
    child.on('error', (err) => {
      reject(new PickerUnavailableError(err.message));
    });
    child.on('close', (code) => {
      if (code === 0) {
        const picked = stdout.trim();
        // A clean exit with no path shouldn't happen, but treat it as a cancel.
        resolve(picked.length > 0 ? picked : null);
        return;
      }
      // The user pressing Cancel is AppleScript error -128 — not a failure. The
      // numeric code is the reliable, locale-independent signal; the text is a
      // secondary guard matching both spellings macOS may emit ("cancelled"/
      // "canceled") in case the code is ever absent.
      if (stderr.includes('-128') || /user cancell?ed/i.test(stderr)) {
        resolve(null);
        return;
      }
      // Any other non-zero exit: the picker mechanism itself failed — fall back.
      reject(new PickerUnavailableError(stderr.trim() || `osascript exited with code ${code}`));
    });
  });
}

// User-facing strings, exported so tests assert on them rather than re-typing.
export const CANCELLED_MESSAGE = 'no folder selected — nothing added';
export const PICKER_UNAVAILABLE_MESSAGE =
  'the folder picker needs macOS; on this system run `munin ingest <folder>` instead';

// Injected so the orchestration is testable: a stub picker drives every branch
// and a fake ingest records what it was called with, with no GUI and no DB.
export interface AddDeps {
  /** Open the chooser. Resolves to a path, null on cancel, or rejects
   * PickerUnavailableError when the mechanism is absent. */
  readonly pickFolder: () => Promise<string | null>;
  /** The existing ingest core — called verbatim with the picked path prepended. */
  readonly ingest: (argv: readonly string[]) => Promise<void>;
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
}

export interface AddResult {
  readonly outcome: 'ingested' | 'cancelled' | 'picker-unavailable';
  /** What the caller should set as the process exit code (0 = clean). */
  readonly exitCode: number;
}

/**
 * Orchestrate `munin add`: pick a folder, then ingest it via the supplied
 * `ingest` (the real `runIngest`). `forwardedArgs` are the already-defaulted
 * `--tags`/`--tenant` flags; the picked folder is prepended as the directory.
 * A held store is left to `ingest`'s own lock pre-flight (its LocalStoreLockedError
 * propagates to the dispatcher's friendly handler — we do not duplicate it).
 */
export async function runAdd(forwardedArgs: readonly string[], deps: AddDeps): Promise<AddResult> {
  let picked: string | null;
  try {
    picked = await deps.pickFolder();
  } catch (err) {
    // Only the missing-mechanism case becomes the fallback; everything else
    // (e.g. a real ingest/store error surfaced earlier) propagates untouched.
    if (err instanceof PickerUnavailableError) {
      deps.logError(PICKER_UNAVAILABLE_MESSAGE);
      return { outcome: 'picker-unavailable', exitCode: 1 };
    }
    throw err;
  }

  if (picked === null) {
    deps.log(CANCELLED_MESSAGE);
    return { outcome: 'cancelled', exitCode: 0 };
  }

  deps.log(`Adding "${picked}" to your Munin memory…`);
  // Reuse the ingest path verbatim — the picked folder is just the directory.
  await deps.ingest([picked, ...forwardedArgs]);
  return { outcome: 'ingested', exitCode: 0 };
}
