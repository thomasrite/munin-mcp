// `munin setup` — ONE guided, resumable wizard that walks a brand-new user from
// nothing to a working, Claude-connected memory (thread D, Option 1).
//
// It ORCHESTRATES the existing commands — it re-implements none of them:
//   1. HOME      runHomeInit          (idempotent; never clobbers an existing home)
//   2. PROVIDER  runSetKey            (cloud) / Ollama-pull guidance (local)
//   3. ADD FILES runAdd → runIngest   (native folder picker)
//   4. CONNECT   runConnect --write   (safe-merge into the client config)
//   5. VERIFY    runDoctor            (the ✓/✗ checklist)
//
// Extraction (building the entity graph) is deliberately NOT a blocking wizard
// step. Retrieval works on the inline embeddings computed at ingest, so the
// memory is searchable the moment files are added; extraction only enriches
// gather/dossier features, can take a long time on a large or local corpus, and
// holds the single-process store while it runs. So the wizard SKIPS it when the
// run added nothing, and otherwise OFFERS it as an explicit opt-in (default NO)
// — a re-run never silently kicks off a long full-corpus extraction.
//
// The whole flow is RESUMABLE and NON-DESTRUCTIVE: every underlying core is
// already idempotent (init reuses a complete home, connect is a fixed point,
// doctor is read-only), so re-running `munin setup` detects what is done and
// continues. It never deletes a store.
//
// All interactivity (prompts) and every orchestrated core are injected via
// SetupDeps — exactly like `munin add`'s AddDeps — so the wizard's branching is
// unit-tested with stubs, with no real stdin / GUI / DB. The real readline-based
// prompts live in `createInteractivePrompts()`, which (like `pickFolder`) is the
// one un-unit-tested seam.

import readline from 'node:readline/promises';

import type { HomeInitResult } from './home-init';
import type { ConnectResult, McpClient } from './mcp-connect';
import type { DoctorReport } from './mcp-doctor';
import { allChecksOk, renderDoctorReport } from './mcp-doctor';
import type { AddResult } from './munin-add';
import { formatSetKeySummary } from './munin-set-key';
import type { CloudProvider, SetKeyResult } from './munin-set-key';

// ---------------------------------------------------------------------------
// Injected surface (prompts + orchestrated cores) — the testable seam
// ---------------------------------------------------------------------------

export interface SetupOption {
  /** The value returned when this option is chosen. */
  readonly value: string;
  /** The line shown to the user. */
  readonly label: string;
}

/**
 * What the ADD-FILES step reports back: the underlying `runAdd` outcome plus the
 * number of NEW documents this run actually ingested. `documentsAdded` is 0 when
 * every picked file was a byte-identical duplicate, the picker was cancelled or
 * unavailable, or the store was locked — the wizard uses it to decide whether
 * there is anything new to extract (and so whether to even offer extraction).
 */
export interface AddOutcome {
  readonly outcome: AddResult['outcome'];
  readonly documentsAdded: number;
}

/** The four interactive primitives the wizard needs. Stubbed in tests. */
export interface SetupPrompts {
  /** Single-choice menu; returns the chosen option's `value`. */
  select(question: string, options: readonly SetupOption[], defaultValue?: string): Promise<string>;
  /** Yes/no; `defaultYes` is the value chosen on a bare Enter. */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /** Hidden input (an API key) — never echoed. */
  secret(question: string): Promise<string>;
  /** Block until the user acknowledges (the "restart your client" beat). */
  pause(message: string): Promise<void>;
}

/**
 * The orchestrated cores, each a thin closure over the real command logic
 * (runHomeInit / runSetKey / runAdd / runExtractCli / runConnect / runDoctor).
 * The wizard calls these; it never reaches the engine or the store directly.
 */
export interface SetupActions {
  /** runHomeInit — provision (or reuse) the home; also loads its env. */
  initHome(): Promise<HomeInitResult>;
  /** runSetKey — point the home at a cloud provider. */
  setKey(provider: CloudProvider, key: string): Promise<SetKeyResult>;
  /** runAdd (native picker → runIngest) with the home's ingest defaults; reports
   * how many NEW documents were ingested so the wizard can gate extraction. */
  addFolder(): Promise<AddOutcome>;
  /** runExtractCli — build the local knowledge graph in-process. Called ONLY when
   * the user explicitly opts in (it can take a long time and holds the store). */
  extract(): Promise<void>;
  /** runConnect --write — merge the `munin` server into the client config. */
  connect(): ConnectResult;
  /** runDoctor — the ✓/✗ verification checklist. */
  doctor(): Promise<DoctorReport>;
}

export interface SetupDeps {
  /** Live process env (real path) or a stub (tests). Read for the current
   * LLM_PROVIDER and the provider key env vars. */
  readonly env: NodeJS.ProcessEnv;
  /** Which AI client to wire (default claude-desktop). */
  readonly client: McpClient;
  readonly prompts: SetupPrompts;
  readonly actions: SetupActions;
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Result (so the dispatcher can set the exit code, and tests can assert)
// ---------------------------------------------------------------------------

export type SetupStepName = 'home' | 'provider' | 'add' | 'extract' | 'connect' | 'verify';
export type SetupStepStatus = 'done' | 'skipped' | 'warn' | 'fail';

export interface SetupStepOutcome {
  readonly step: SetupStepName;
  readonly status: SetupStepStatus;
  readonly detail?: string;
}

export interface SetupResult {
  readonly home: string;
  readonly tenantId: string;
  readonly steps: readonly SetupStepOutcome[];
  /** 0 = clean; 1 = the connection was not established or a check failed. */
  readonly exitCode: number;
}

// ---------------------------------------------------------------------------
// User-facing strings (exported so tests assert on them, not re-typed copies)
// ---------------------------------------------------------------------------

export const SETUP_HEADER = `munin setup — let's connect your local memory to your AI client.

This guided walkthrough does five things, and you can re-run \`munin setup\` any
time — it detects what's already done and never wipes your data:
  1. set up your Munin home   2. choose your AI provider   3. add your files
  4. connect your AI client   5. verify the connection`;

export const PROVIDER_INTRO = `Munin uses an AI model to read your documents and answer your questions.
Pick where that model runs:`;

export const LOCAL_PROVIDER_GUIDANCE = `✓ Staying fully local — your documents never leave this machine (zero egress).
  One-time setup (Munin does NOT install this for you):
    1. Install Ollama from https://ollama.com and make sure it is running.
    2. Pull the models:  ollama pull qwen2.5:7b && ollama pull bge-m3`;

export const LOCAL_FROM_CLOUD_NOTE = `  Note: your home is currently set to a cloud provider. To go fully local again,
  edit munin.env: set MUNIN_LOCAL_MODE=true and LLM_PROVIDER=ollama.`;

export const NO_KEY_MESSAGE = `No API key entered — leaving your AI provider unchanged. Re-run \`munin setup\`
(or \`munin set-key\`) once you have a key.`;

export const QUIT_BEFORE_INGEST_NOTE = `Heads-up: your local memory is single-process. If Claude Desktop is already
running and connected to Munin, quit it before adding files.`;

export const ADD_SKIPPED_MESSAGE = `Skipped — add documents any time with \`munin add\` (native folder picker) or
\`munin ingest <dir>\`.`;

export const ADD_LOCKED_MESSAGE = `Couldn't add files: your local memory is in use by another process (most likely
your AI client). Quit Claude Desktop (or Cursor), then re-run \`munin setup\`.
Continuing with the rest of setup for now.`;

// Shown when this run added new documents, BEFORE the opt-in prompt — frames
// extraction as optional and warns about its cost. Verbatim wording matters: it
// is the honest "you're already done; this is extra" message.
export const EXTRACTION_OPTIONAL_MESSAGE = `Your memory is ready to search now — embeddings are done. Building the entity
graph (extraction) is optional, can take a long time on a large or local corpus,
and holds the store while it runs. Run \`munin extract\` later if you want
entity/dossier features.`;

// The explicit opt-in question. Defaults to NO (see runSetup) so a bare Enter —
// or a re-run — never starts a long extraction.
export const EXTRACTION_PROMPT = 'Build the entity graph now? (optional)';

// Shown when the user declines (the default) — reassures that retrieval works
// and points at the standalone command.
export const EXTRACTION_DECLINED_MESSAGE = `Skipped — your files are searchable now. Run \`munin extract\` any time you want
entity/dossier features (it can take a while and holds the store while it runs).`;

// Shown when the add step ran but every file was already in memory: nothing new
// to extract, so we never even offer it (and never churn the whole corpus).
export const EXTRACTION_NOTHING_NEW_MESSAGE =
  'No new documents were added, so there is nothing new to extract — your memory is unchanged.';

// Shown ONLY on the opt-in accept path, right before the (blocking) extract runs.
export const BUILDING_GRAPH_MESSAGE = `Building the entity graph now. This can take a while on a large or local corpus,
and it holds your local memory while it runs — do not open your AI client until
it finishes.`;
export const GRAPH_BUILT_MESSAGE = '✓ Knowledge graph updated.';
export const GRAPH_FAILED_PREFIX = "! Couldn't finish building the knowledge graph: ";
export const GRAPH_FAILED_GUIDANCE =
  '  Your files are still searchable. Re-run `munin extract` later to build the graph.';

export const STORE_IN_USE_EXPLANATION = `ℹ The check above says your local store is "in use by your AI client". That is
  the EXPECTED, healthy state once Claude Desktop is running and connected — the
  local store is single-process, so your client legitimately holds it.`;

export const SETUP_INCOMPLETE_MESSAGE = `Setup finished with issues above. Fix them and re-run \`munin setup\` — it will
skip the steps that are already done.`;

/** Human label for an MCP client (used in the restart/closing narration). */
export function clientLabel(client: McpClient): string {
  return client === 'cursor' ? 'Cursor' : 'Claude Desktop';
}

export function stepHeader(n: number, title: string): string {
  return `Step ${n}/5 — ${title}`;
}

export function keyEnvNudge(keyVar: string): string {
  return `  Tip: to keep your key out of your shell history, you can cancel now, run
  \`export ${keyVar}=...\`, and re-run \`munin setup\` — Munin will pick it up.`;
}

export function restartMessage(client: McpClient): string {
  const label = clientLabel(client);
  return `▶ RESTART ${label} now so it loads the Munin connection.
  Quit it completely (not just close the window), then reopen it.`;
}

export function restartPausePrompt(client: McpClient): string {
  return `Press Enter once ${clientLabel(client)} has restarted (or to verify now)… `;
}

export function setupCompleteMessage(client: McpClient): string {
  const label = clientLabel(client);
  return `✓ Setup complete. Open ${label} and ask it something about your files.
  To add more later: quit ${label}, run \`munin add\`, then reopen it.`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Normalise the configured LLM provider for the "already on a cloud provider?"
 * branch. Empty/whitespace → undefined. */
function normaliseProvider(value: string | undefined): string | undefined {
  const t = value?.trim().toLowerCase();
  return t ? t : undefined;
}

/** The provider-step sub-flow. Returns the step outcome; performs no I/O beyond
 * the injected prompts/actions/log. */
async function runProviderStep(
  deps: SetupDeps,
  current: string | undefined,
): Promise<SetupStepOutcome> {
  const { prompts, actions, log, logError, env } = deps;
  const currentIsCloud = current === 'anthropic' || current === 'openai';

  const options: readonly SetupOption[] = [
    { value: 'local', label: 'Local — Ollama on this machine (free, fully private, zero egress)' },
    {
      value: 'anthropic',
      label: 'Anthropic Claude (cloud) — best extraction quality, needs an API key',
    },
    {
      value: 'openai',
      label: 'OpenAI GPT (cloud) — cloud embeddings too, needs an API key',
    },
  ];
  // Default to the currently-configured provider so a re-run pre-selects it; a
  // fresh / ollama home defaults to local.
  const defaultValue = currentIsCloud ? (current as string) : 'local';
  const choice = await prompts.select('Which AI provider should Munin use?', options, defaultValue);

  if (choice === 'local') {
    log(LOCAL_PROVIDER_GUIDANCE);
    if (currentIsCloud) log(LOCAL_FROM_CLOUD_NOTE);
    return { step: 'provider', status: 'done', detail: 'local' };
  }

  const provider = choice as CloudProvider;

  // Resumability: already on this provider → offer to keep without re-entering
  // the key (no new backup, no re-prompt). Default is to keep.
  if (current === provider) {
    const reapply = await prompts.confirm(
      `Munin is already set up for ${provider}. Re-apply provider settings / key?`,
      false,
    );
    if (!reapply) {
      log(`Keeping your existing ${provider} configuration.`);
      return { step: 'provider', status: 'skipped', detail: `keep-${provider}` };
    }
  }

  // Prefer the provider's env var (out of shell history); else prompt (hidden).
  const keyVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  let key = env[keyVar]?.trim();
  let source: 'env' | 'prompt';
  if (key) {
    log(`✓ Using ${keyVar} from your environment (it stays out of your shell history).`);
    source = 'env';
  } else {
    log(keyEnvNudge(keyVar));
    key = (
      await prompts.secret(
        `Paste your ${provider} API key (hidden; saved to munin.env at mode 0600, never shown): `,
      )
    ).trim();
    source = 'prompt';
  }
  if (!key) {
    logError(NO_KEY_MESSAGE);
    return { step: 'provider', status: 'warn', detail: 'no-key' };
  }

  const result = await actions.setKey(provider, key);
  log(formatSetKeySummary(result));
  return { step: 'provider', status: 'done', detail: `${provider}:${source}` };
}

/** The error line for a refused connect (mirrors cmdMcpConnect's refusalMessage). */
function refusedConnectMessage(result: ConnectResult): string {
  switch (result.refusalReason) {
    case 'symlink':
      return `✗ Refusing to write: ${result.targetPath} is a symlink (we don't write through links).`;
    case 'unpinned-node':
      return (
        '✗ Refusing to write an unpinned launcher (this was not run under pnpm, so Munin cannot pin\n' +
        '  the exact Node). Re-run setup via pnpm: `pnpm --filter munin-mcp munin setup`.'
      );
    default:
      return `✗ Refusing to write: ${result.targetPath} is not valid JSON (won't clobber it).`;
  }
}

/** Narrate a connect result (mirrors cmdMcpConnect's switch) and classify it. */
function narrateConnect(deps: SetupDeps, result: ConnectResult): SetupStepStatus {
  switch (result.action) {
    case 'written':
      deps.log(`✓ Wrote the \`munin\` MCP server to ${result.targetPath}`);
      if (result.backupPath) {
        deps.log(`  backed up the previous config to ${result.backupPath}`);
      }
      return 'done';
    case 'unchanged':
      deps.log(`✓ ${result.targetPath} already has the \`munin\` server — no change.`);
      return 'done';
    case 'refused':
      deps.logError(refusedConnectMessage(result));
      // For symlink/unparseable the user can hand-paste; an unpinned-node refusal
      // is a launcher problem, not a config-file problem, so the block won't help
      // — steer them to re-run under pnpm instead.
      if (result.refusalReason !== 'unpinned-node') {
        deps.logError('Paste this block into your client config by hand instead:');
        deps.log(result.block);
      }
      return 'fail';
    case 'printed':
      // setup always writes, so this is defensive — surface the block anyway.
      deps.log(result.block);
      return 'warn';
  }
}

/**
 * Run the guided setup. Pure orchestration over the injected deps — no direct
 * stdin / GUI / store access, so the branching is fully unit-tested with stubs.
 */
export async function runSetup(deps: SetupDeps): Promise<SetupResult> {
  const { prompts, actions, log, logError } = deps;
  const steps: SetupStepOutcome[] = [];

  log(SETUP_HEADER);

  // --- Step 1: HOME --------------------------------------------------------
  log('');
  log(stepHeader(1, 'Set up your Munin home'));
  const home = await actions.initHome();
  log(
    home.wroteEnv
      ? `✓ Created your Munin home at ${home.home}`
      : `✓ Found an existing Munin home at ${home.home} — leaving it untouched.`,
  );
  log(`  tenant: ${home.tenantId}`);
  steps.push({ step: 'home', status: 'done', detail: home.wroteEnv ? 'created' : 'reused' });

  // --- Step 2: PROVIDER / KEY ---------------------------------------------
  log('');
  log(stepHeader(2, 'Choose your AI provider'));
  log(PROVIDER_INTRO);
  // The env was loaded by initHome (real path: process.env now reflects
  // munin.env), so LLM_PROVIDER tells us whether the home is already on cloud.
  const current = normaliseProvider(deps.env.LLM_PROVIDER);
  steps.push(await runProviderStep(deps, current));

  // --- Step 3: ADD FILES ---------------------------------------------------
  log('');
  log(stepHeader(3, 'Add your files'));
  log(QUIT_BEFORE_INGEST_NOTE);
  // `addRan` = the ingest core actually executed (vs skipped/cancelled/locked);
  // `documentsAdded` = how many NEW documents it wrote this run. Both gate the
  // extraction offer below.
  let addRan = false;
  let documentsAdded = 0;
  const wantAdd = await prompts.confirm('Add a folder of documents now?', true);
  if (!wantAdd) {
    log(ADD_SKIPPED_MESSAGE);
    steps.push({ step: 'add', status: 'skipped' });
  } else {
    try {
      const result = await actions.addFolder();
      if (result.outcome === 'ingested') {
        addRan = true;
        documentsAdded = result.documentsAdded;
        steps.push({ step: 'add', status: 'done', detail: `ingested:${documentsAdded}` });
      } else if (result.outcome === 'cancelled') {
        log(ADD_SKIPPED_MESSAGE);
        steps.push({ step: 'add', status: 'skipped', detail: 'cancelled' });
      } else {
        // picker-unavailable: runAdd already logged the fallback guidance.
        steps.push({ step: 'add', status: 'warn', detail: 'picker-unavailable' });
      }
    } catch (err) {
      // A live store holder (the AI client) is an EXPECTED hazard on a re-run —
      // narrate the quit-Claude remedy and continue rather than aborting the
      // whole wizard. Any other error propagates to the dispatcher's handler.
      if ((err as Error).name === 'LocalStoreLockedError') {
        logError(ADD_LOCKED_MESSAGE);
        steps.push({ step: 'add', status: 'warn', detail: 'store-locked' });
      } else {
        throw err;
      }
    }
  }

  // --- Build the entity graph (OPTIONAL — opt-in, never auto-runs) ---------
  // Extraction is not on the onboarding critical path: retrieval already works
  // on the inline embeddings. We OFFER it only when this run added new documents,
  // and the prompt defaults to NO — so a bare Enter, or a re-run that adds
  // nothing, never starts a long full-corpus extraction that would hold the
  // single-process store for many minutes.
  if (documentsAdded > 0) {
    log('');
    log(EXTRACTION_OPTIONAL_MESSAGE);
    const wantExtract = await prompts.confirm(EXTRACTION_PROMPT, false);
    if (wantExtract) {
      log('');
      log(BUILDING_GRAPH_MESSAGE);
      try {
        await actions.extract();
        log(GRAPH_BUILT_MESSAGE);
        steps.push({ step: 'extract', status: 'done' });
      } catch (err) {
        // Non-fatal: a local extraction can fail on a missing model. The documents
        // are still embedded and searchable — warn and carry on to connect.
        const msg = (err as Error).message ?? String(err);
        logError(`${GRAPH_FAILED_PREFIX}${msg}`);
        log(GRAPH_FAILED_GUIDANCE);
        steps.push({ step: 'extract', status: 'warn', detail: msg });
      }
    } else {
      log(EXTRACTION_DECLINED_MESSAGE);
      steps.push({ step: 'extract', status: 'skipped', detail: 'declined' });
    }
  } else {
    // Nothing new this run. If the add step ran but every file was a duplicate,
    // say so plainly; otherwise (skipped/cancelled/unavailable/locked) the add
    // step already narrated its own outcome.
    if (addRan) log(EXTRACTION_NOTHING_NEW_MESSAGE);
    steps.push({ step: 'extract', status: 'skipped', detail: addRan ? 'nothing-new' : 'no-files' });
  }

  // --- Step 4: CONNECT -----------------------------------------------------
  log('');
  log(stepHeader(4, `Connect ${clientLabel(deps.client)}`));
  const connectResult = actions.connect();
  const connectStatus = narrateConnect(deps, connectResult);
  steps.push({ step: 'connect', status: connectStatus, detail: connectResult.action });

  // The restart beat — connect is done, doctor comes next, so THIS is the moment.
  log('');
  log(restartMessage(deps.client));
  await prompts.pause(restartPausePrompt(deps.client));

  // --- Step 5: VERIFY ------------------------------------------------------
  log('');
  log(stepHeader(5, 'Verify the connection'));
  const report = await actions.doctor();
  log(renderDoctorReport(report.home, report.checks));
  const inUse = report.checks.some((c) => c.detail?.includes('in use by your AI client'));
  if (inUse) {
    log('');
    log(STORE_IN_USE_EXPLANATION);
  }
  const doctorOk = allChecksOk(report.checks);
  steps.push({
    step: 'verify',
    status: doctorOk ? 'done' : 'fail',
    detail: inUse ? 'in-use' : doctorOk ? 'ok' : 'has-failures',
  });

  // --- Closing -------------------------------------------------------------
  // The connection counts as "not established" whenever the connect step did not
  // land cleanly — a refusal (must hand-paste) or the unreachable print-only
  // path. Derive from the classified status so the exit code can't drift from
  // what the step reported.
  const connectFailed = connectStatus === 'fail' || connectStatus === 'warn';
  const exitCode = !doctorOk || connectFailed ? 1 : 0;
  log('');
  log(exitCode === 0 ? setupCompleteMessage(deps.client) : SETUP_INCOMPLETE_MESSAGE);

  return { home: home.home, tenantId: home.tenantId, steps, exitCode };
}

// ---------------------------------------------------------------------------
// Real interactive prompts (the un-unit-tested seam, like `pickFolder`)
// ---------------------------------------------------------------------------

/**
 * readline-backed prompts for the live CLI. Not unit-tested directly (it drives
 * real stdin/stdout); the wizard's branching is tested with stub prompts. Each
 * call opens and closes its own interface so a cancelled prompt cannot leave the
 * TTY in a half-open state.
 */
export function createInteractivePrompts(): SetupPrompts {
  const { stdin, stdout } = process;
  return {
    async select(question, options, defaultValue) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        const defIdx = options.findIndex((o) => o.value === defaultValue);
        stdout.write(`\n${question}\n`);
        options.forEach((o, i) => {
          stdout.write(`  ${i + 1}) ${o.label}${i === defIdx ? '  [default]' : ''}\n`);
        });
        for (;;) {
          const ans = (
            await rl.question(`Enter a number${defIdx >= 0 ? ` [${defIdx + 1}]` : ''}: `)
          ).trim();
          if (ans === '' && defIdx >= 0) {
            const chosen = options[defIdx];
            if (chosen) return chosen.value;
          }
          const n = Number.parseInt(ans, 10);
          if (Number.isInteger(n) && n >= 1 && n <= options.length) {
            const chosen = options[n - 1];
            if (chosen) return chosen.value;
          }
          stdout.write('  Please enter one of the option numbers above.\n');
        }
      } finally {
        rl.close();
      }
    },
    async confirm(question, defaultYes) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        const hint = defaultYes ? 'Y/n' : 'y/N';
        const ans = (await rl.question(`${question} [${hint}] `)).trim().toLowerCase();
        if (ans === '') return defaultYes;
        return ans === 'y' || ans === 'yes';
      } finally {
        rl.close();
      }
    },
    secret(question) {
      return readSecret(question);
    },
    async pause(message) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        await rl.question(message);
      } finally {
        rl.close();
      }
    },
  };
}

// The minimal stdin/stdout surfaces readSecret needs. process.stdin / .stdout
// satisfy these; tests substitute a fake TTY to assert masking without a real
// terminal.
export interface SecretInput {
  readonly isTTY?: boolean;
  /** Whether raw mode is currently engaged (captured so it can be restored). */
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  // BufferEncoding (not plain string) so process.stdin satisfies this interface.
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string) => void): unknown;
}
export interface SecretOutput {
  write(chunk: string): unknown;
}
export interface SecretIO {
  readonly input: SecretInput;
  readonly output: SecretOutput;
}

/**
 * Hidden-input prompt for an API key. The previous implementation overrode
 * readline's `_writeToOutput`, which suppressed TYPED echo but NOT the terminal's
 * own echo of PASTED input — so a pasted key still appeared on screen and in
 * scrollback (a real secret-exposure bug). This version puts the TTY into RAW
 * MODE, which disables the terminal's echo entirely, then reads bytes itself and
 * writes none — so typed AND pasted keys are masked. The terminal state is always
 * restored (raw mode reset + stdin paused), on success or error.
 *
 * On a non-TTY stdin (piped input, CI, tests without a fake TTY) there is no
 * terminal echo to suppress and setRawMode does not exist, so it reads one line
 * plainly. Injectable IO so the masking is unit-testable.
 */
export function readSecret(
  question: string,
  io: SecretIO = { input: process.stdin, output: process.stdout },
): Promise<string> {
  const { input, output } = io;
  output.write(question);

  if (input.isTTY !== true || typeof input.setRawMode !== 'function') {
    return readPlainLine(input, output);
  }

  return new Promise<string>((resolve, reject) => {
    const wasRaw = input.isRaw === true;
    let buf = '';
    let settled = false;

    const restoreAnd = (act: () => void): void => {
      if (settled) return;
      settled = true;
      input.removeListener('data', onData);
      // finally-equivalent: undo raw mode and stop reading on BOTH paths.
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write('\n'); // the masked Enter produced no newline — restore it.
      act();
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r') {
          restoreAnd(() => resolve(buf));
          return;
        }
        if (ch === '\u0003') {
          // Ctrl-C — abort the prompt rather than returning a partial key.
          restoreAnd(() => reject(new Error('input cancelled')));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        // Accumulate every printable char (including a pasted run) and echo
        // NOTHING — that silence is the masking.
        if (ch >= ' ') buf += ch;
      }
    };

    input.setEncoding('utf8');
    // Guaranteed defined by the guard above; `?.` keeps the type checker happy
    // without a non-null assertion (it can never short-circuit here).
    input.setRawMode?.(true);
    input.resume();
    input.on('data', onData);
  });
}

/** Read a single line from a non-TTY stream (no masking possible — there is no
 * terminal echo to suppress). Used for piped stdin / tests. */
function readPlainLine(input: SecretInput, output: SecretOutput): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = '';
    const onData = (chunk: string): void => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      input.removeListener('data', onData);
      input.pause();
      output.write('\n');
      resolve(buf.slice(0, nl).replace(/\r$/, ''));
    };
    input.setEncoding('utf8');
    input.resume();
    input.on('data', onData);
  });
}
