// `munin setup` — unit tests for the wizard orchestration. Every prompt and
// every orchestrated core is a STUB (vi.fn), so the branching is exercised with
// no real stdin / GUI / store — the same testing posture as `munin add`'s
// `runAdd` (stub picker + fake ingest). `createInteractivePrompts` (the readline
// seam) is deliberately not unit-tested, mirroring `pickFolder`.

import { muninHomeLayout } from '@muninhq/shared';
import { describe, expect, it, vi } from 'vitest';

import type { HomeInitResult } from './home-init';
import type { ConnectResult } from './mcp-connect';
import type { DoctorCheck, DoctorReport } from './mcp-doctor';
import {
  ANTHROPIC_MODEL,
  type CloudProvider,
  OPENAI_MODEL,
  type SetKeyResult,
} from './munin-set-key';
import {
  ADD_LOCKED_MESSAGE,
  ADD_SKIPPED_MESSAGE,
  type AddOutcome,
  BUILDING_GRAPH_MESSAGE,
  EXTRACTION_DECLINED_MESSAGE,
  EXTRACTION_NOTHING_NEW_MESSAGE,
  EXTRACTION_OPTIONAL_MESSAGE,
  EXTRACTION_PROMPT,
  GRAPH_BUILT_MESSAGE,
  GRAPH_FAILED_PREFIX,
  LOCAL_FROM_CLOUD_NOTE,
  LOCAL_PROVIDER_GUIDANCE,
  NO_KEY_MESSAGE,
  SETUP_HEADER,
  SETUP_INCOMPLETE_MESSAGE,
  STORE_IN_USE_EXPLANATION,
  type SetupDeps,
  type SetupOption,
  type SetupPrompts,
  runSetup,
} from './munin-setup';

// --- fixture builders -------------------------------------------------------

function homeResult(over: Partial<HomeInitResult> = {}): HomeInitResult {
  return {
    home: '/home/u/.munin',
    envPath: '/home/u/.munin/munin.env',
    tenantId: 't-1',
    tenantCreated: true,
    wroteEnv: true,
    pgliteDataDir: '/home/u/.munin/pgdata',
    blobFsRoot: '/home/u/.munin/blobs',
    configPackage: '@muninhq/config-personal',
    ...over,
  };
}

function connectResult(over: Partial<ConnectResult> = {}): ConnectResult {
  return {
    action: 'written',
    targetPath: '/home/u/Library/Application Support/Claude/claude_desktop_config.json',
    block: '{\n  "mcpServers": {\n    "munin": {}\n  }\n}',
    pinned: true,
    homeBaked: false,
    launchMode: 'installed',
    ...over,
  };
}

function doctorReport(checks: DoctorCheck[]): DoctorReport {
  const home = '/home/u/.munin';
  return { home, layout: muninHomeLayout(home), checks };
}

function setKeyResult(provider: CloudProvider): SetKeyResult {
  return {
    envPath: '/home/u/.munin/munin.env',
    provider,
    llmProvider: provider,
    embeddingProvider: provider === 'openai' ? 'openai' : 'ollama',
    model: provider === 'anthropic' ? ANTHROPIC_MODEL : OPENAI_MODEL,
    keyVar: provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',
    reEmbedNeeded: false,
    backupPath: '/home/u/.munin/munin.env.munin-backup-x',
  };
}

// The default "added" outcome: the ingest core ran and wrote 3 NEW documents, so
// extraction has something to build (and is therefore OFFERED — opt-in, default
// NO). Tests that need "nothing new" pass documentsAdded: 0.
const INGESTED: AddOutcome = { outcome: 'ingested', documentsAdded: 3 };

interface MakeDepsOptions {
  env?: NodeJS.ProcessEnv;
  home?: HomeInitResult;
  connect?: ConnectResult;
  doctorChecks?: DoctorCheck[];
  addResult?: AddOutcome;
  addImpl?: () => Promise<AddOutcome>;
  extractImpl?: () => Promise<void>;
  setKeyImpl?: (provider: CloudProvider, key: string) => Promise<SetKeyResult>;
  select?: SetupPrompts['select'];
  confirm?: SetupPrompts['confirm'];
  secret?: SetupPrompts['secret'];
}

function makeDeps(opts: MakeDepsOptions = {}) {
  const logs: string[] = [];
  const errors: string[] = [];

  const initHome = vi.fn(async () => opts.home ?? homeResult());
  const setKey = vi.fn(opts.setKeyImpl ?? (async (p: CloudProvider) => setKeyResult(p)));
  const addFolder = vi.fn(opts.addImpl ?? (async () => opts.addResult ?? INGESTED));
  const extract = vi.fn(opts.extractImpl ?? (async () => {}));
  const connect = vi.fn(() => opts.connect ?? connectResult());
  const doctor = vi.fn(async () =>
    doctorReport(opts.doctorChecks ?? [{ label: 'all checks', status: 'ok' }]),
  );

  const select = vi.fn(
    opts.select ??
      (async (_q: string, options: readonly SetupOption[], def?: string) => {
        const first = options[0];
        return def ?? (first ? first.value : '');
      }),
  );
  const confirm = vi.fn(opts.confirm ?? (async (_q: string, d: boolean) => d));
  const secret = vi.fn(opts.secret ?? (async () => 'sk-test'));
  const pause = vi.fn(async () => {});

  const prompts: SetupPrompts = { select, confirm, secret, pause };
  const actions = { initHome, setKey, addFolder, extract, connect, doctor };
  const deps: SetupDeps = {
    env: opts.env ?? {},
    client: 'claude-desktop',
    prompts,
    actions,
    log: (l) => logs.push(l),
    logError: (l) => errors.push(l),
  };
  // `spies` keeps the raw vi.fn references so tests can read `.mock` (the typed
  // `deps.prompts`/`deps.actions` surfaces erase the mock type).
  const spies = { select, confirm, secret, pause };
  return { deps, actions, prompts, spies, logs, errors };
}

const joined = (lines: string[]): string => lines.join('\n');

// --- tests ------------------------------------------------------------------

describe('runSetup — fresh home, fully-local, all steps', () => {
  it('provisions, stays local, ingests, OFFERS extraction (declined by default), connects, verifies clean', async () => {
    // Default confirm returns the prompt's default: "Add a folder?" → yes,
    // "Build the entity graph?" → NO. So a user pressing Enter through the wizard
    // gets a searchable memory WITHOUT a blocking extraction.
    const { deps, actions, logs } = makeDeps({ env: {} }); // no LLM_PROVIDER → local default

    const result = await runSetup(deps);

    expect(actions.initHome).toHaveBeenCalledOnce();
    expect(actions.setKey).not.toHaveBeenCalled(); // local → no cloud key
    expect(actions.addFolder).toHaveBeenCalledOnce();
    expect(actions.extract).not.toHaveBeenCalled(); // opt-in defaults to NO
    expect(actions.connect).toHaveBeenCalledOnce();
    expect(actions.doctor).toHaveBeenCalledOnce();

    expect(result.exitCode).toBe(0);
    expect(result.home).toBe('/home/u/.munin');
    expect(result.tenantId).toBe('t-1');

    const out = joined(logs);
    expect(out).toContain(SETUP_HEADER);
    expect(out).toContain('✓ Created your Munin home at /home/u/.munin');
    expect(out).toContain('tenant: t-1');
    expect(out).toContain(LOCAL_PROVIDER_GUIDANCE);
    // Extraction is offered (added > 0) but declined by default — no graph build.
    expect(out).toContain(EXTRACTION_OPTIONAL_MESSAGE);
    expect(out).toContain(EXTRACTION_DECLINED_MESSAGE);
    expect(out).not.toContain(GRAPH_BUILT_MESSAGE);
    expect(out).toContain('RESTART Claude Desktop');

    const steps = result.steps.map((s) => `${s.step}:${s.status}`);
    expect(steps).toEqual([
      'home:done',
      'provider:done',
      'add:done',
      'extract:skipped',
      'connect:done',
      'verify:done',
    ]);
  });

  it('connect → pause → doctor happen in that order (restart beat lands between)', async () => {
    const { deps, actions, spies } = makeDeps();
    await runSetup(deps);
    const connectAt = actions.connect.mock.invocationCallOrder[0] ?? 0;
    const pauseAt = spies.pause.mock.invocationCallOrder[0] ?? 0;
    const doctorAt = actions.doctor.mock.invocationCallOrder[0] ?? 0;
    expect(connectAt).toBeLessThan(pauseAt);
    expect(pauseAt).toBeLessThan(doctorAt);
  });
});

describe('runSetup — existing home (resumable, non-destructive)', () => {
  it('reports the home is reused and untouched (init does not clobber)', async () => {
    const { deps, actions, logs } = makeDeps({ home: homeResult({ wroteEnv: false }) });

    const result = await runSetup(deps);

    expect(actions.initHome).toHaveBeenCalledOnce();
    const out = joined(logs);
    expect(out).toContain(
      '✓ Found an existing Munin home at /home/u/.munin — leaving it untouched.',
    );
    expect(result.steps[0]).toEqual({ step: 'home', status: 'done', detail: 'reused' });
  });
});

describe('runSetup — provider branch (cloud vs local)', () => {
  it('anthropic with the env var set → set-key with the env key, no secret prompt', async () => {
    const { deps, actions, prompts, logs } = makeDeps({
      env: { ANTHROPIC_API_KEY: 'sk-env' },
      select: async () => 'anthropic',
    });

    await runSetup(deps);

    expect(prompts.secret).not.toHaveBeenCalled();
    expect(actions.setKey).toHaveBeenCalledExactlyOnceWith('anthropic', 'sk-env');
    expect(joined(logs)).toContain(
      '✓ Using ANTHROPIC_API_KEY from your environment (it stays out of your shell history).',
    );
  });

  it('openai with no env var → prompts (hidden) and set-key with the pasted key', async () => {
    const { deps, actions, prompts } = makeDeps({
      env: {},
      select: async () => 'openai',
      secret: async () => 'sk-pasted',
    });

    await runSetup(deps);

    expect(prompts.secret).toHaveBeenCalledOnce();
    expect(actions.setKey).toHaveBeenCalledExactlyOnceWith('openai', 'sk-pasted');
  });

  it('cloud chosen but no key anywhere → warn, set-key NOT called, leaves provider unchanged', async () => {
    const { deps, actions, errors, logs } = makeDeps({
      env: {},
      select: async () => 'anthropic',
      secret: async () => '   ', // user just hit Enter
    });

    const result = await runSetup(deps);

    expect(actions.setKey).not.toHaveBeenCalled();
    expect(joined(errors)).toContain(NO_KEY_MESSAGE);
    expect(result.steps.find((s) => s.step === 'provider')).toEqual({
      step: 'provider',
      status: 'warn',
      detail: 'no-key',
    });
    // still proceeds to connect + verify
    expect(actions.connect).toHaveBeenCalledOnce();
    expect(joined(logs)).toContain('Step 4/5');
  });

  it('local provider prints the Ollama pull guidance and does not call set-key', async () => {
    const { deps, actions, logs } = makeDeps({ select: async () => 'local' });
    await runSetup(deps);
    expect(actions.setKey).not.toHaveBeenCalled();
    const out = joined(logs);
    expect(out).toContain('ollama pull qwen2.5:7b && ollama pull bge-m3');
    expect(out).toContain('Munin does NOT install this for you');
  });

  it('choosing local while currently on cloud adds the "edit munin.env to go local" note', async () => {
    const { deps, actions, logs } = makeDeps({
      env: { LLM_PROVIDER: 'anthropic' },
      select: async () => 'local',
    });
    await runSetup(deps);
    expect(actions.setKey).not.toHaveBeenCalled(); // no command flips cloud→local
    expect(joined(logs)).toContain(LOCAL_FROM_CLOUD_NOTE);
  });
});

describe('runSetup — resumability of the provider step', () => {
  it('already on anthropic, declines re-apply → keeps existing, no set-key', async () => {
    const { deps, actions, logs } = makeDeps({
      env: { LLM_PROVIDER: 'anthropic' },
      select: async () => 'anthropic',
      confirm: async (q, d) => (q.includes('Re-apply') ? false : d),
    });

    await runSetup(deps);

    expect(actions.setKey).not.toHaveBeenCalled();
    expect(joined(logs)).toContain('Keeping your existing anthropic configuration.');
  });

  it('already on anthropic, accepts re-apply with env key → set-key runs again', async () => {
    const { deps, actions } = makeDeps({
      env: { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-env' },
      select: async () => 'anthropic',
      confirm: async (q, d) => (q.includes('Re-apply') ? true : d),
    });

    await runSetup(deps);

    expect(actions.setKey).toHaveBeenCalledExactlyOnceWith('anthropic', 'sk-env');
  });
});

describe('runSetup — add-files step (skip / cancel / lock)', () => {
  it('user declines to add → no ingest, no extract, "you can add any time"', async () => {
    const { deps, actions, logs } = makeDeps({
      select: async () => 'local',
      confirm: async (q, d) => (q.includes('Add a folder') ? false : d),
    });

    const result = await runSetup(deps);

    expect(actions.addFolder).not.toHaveBeenCalled();
    expect(actions.extract).not.toHaveBeenCalled();
    expect(joined(logs)).toContain(ADD_SKIPPED_MESSAGE);
    expect(result.steps.find((s) => s.step === 'add')?.status).toBe('skipped');
    expect(result.steps.find((s) => s.step === 'extract')?.status).toBe('skipped');
  });

  it('picker cancelled → counts as skipped, no extract', async () => {
    const { deps, actions } = makeDeps({
      select: async () => 'local',
      addResult: { outcome: 'cancelled', documentsAdded: 0 },
    });

    const result = await runSetup(deps);

    expect(actions.addFolder).toHaveBeenCalledOnce();
    expect(actions.extract).not.toHaveBeenCalled();
    expect(result.steps.find((s) => s.step === 'add')?.status).toBe('skipped');
  });

  it('picker unavailable → warn step, no extract, continues (runAdd logged the fallback)', async () => {
    const { deps, actions } = makeDeps({
      select: async () => 'local',
      addResult: { outcome: 'picker-unavailable', documentsAdded: 0 },
    });

    const result = await runSetup(deps);

    expect(actions.addFolder).toHaveBeenCalledOnce();
    expect(actions.extract).not.toHaveBeenCalled();
    expect(actions.connect).toHaveBeenCalledOnce();
    expect(result.steps.find((s) => s.step === 'add')).toEqual({
      step: 'add',
      status: 'warn',
      detail: 'picker-unavailable',
    });
    expect(result.exitCode).toBe(0); // a missing picker doesn't fail the wizard
  });

  it('store locked during add → warn + remedy, continues to connect/verify (non-fatal)', async () => {
    const lockErr = Object.assign(new Error('locked'), { name: 'LocalStoreLockedError' });
    const { deps, actions, errors } = makeDeps({
      select: async () => 'local',
      addImpl: async () => {
        throw lockErr;
      },
    });

    const result = await runSetup(deps);

    expect(joined(errors)).toContain(ADD_LOCKED_MESSAGE);
    expect(actions.extract).not.toHaveBeenCalled();
    expect(actions.connect).toHaveBeenCalledOnce(); // wizard kept going
    expect(actions.doctor).toHaveBeenCalledOnce();
    expect(result.steps.find((s) => s.step === 'add')?.status).toBe('warn');
    expect(result.exitCode).toBe(0);
  });

  it('a non-lock error during add propagates (not swallowed)', async () => {
    const { deps } = makeDeps({
      select: async () => 'local',
      addImpl: async () => {
        throw new Error('disk full');
      },
    });
    await expect(runSetup(deps)).rejects.toThrow('disk full');
  });
});

describe('runSetup — extract is non-fatal (on the opt-in accept path)', () => {
  it('extract failure → warn + guidance, setup still finishes clean', async () => {
    const { deps, errors, logs } = makeDeps({
      select: async () => 'local',
      // Accept the optional extraction so the failing extract actually runs.
      confirm: async (q, d) => (q === EXTRACTION_PROMPT ? true : d),
      extractImpl: async () => {
        throw new Error('model qwen2.5:7b not found');
      },
    });

    const result = await runSetup(deps);

    expect(joined(errors)).toContain(`${GRAPH_FAILED_PREFIX}model qwen2.5:7b not found`);
    expect(joined(logs)).toContain('munin extract');
    expect(result.steps.find((s) => s.step === 'extract')?.status).toBe('warn');
    expect(result.exitCode).toBe(0); // documents still searchable
  });
});

describe('runSetup — extraction is optional and opt-in', () => {
  it('0 documents added (all already in memory) → extraction not offered, step skipped, no extract call', async () => {
    // The dogfooding bug: a re-run that adds nothing must NOT churn the whole
    // corpus. addFolder reports the ingest ran but wrote 0 NEW documents.
    const { deps, actions, spies, logs } = makeDeps({
      select: async () => 'local',
      addResult: { outcome: 'ingested', documentsAdded: 0 },
    });

    const result = await runSetup(deps);

    expect(actions.addFolder).toHaveBeenCalledOnce();
    expect(actions.extract).not.toHaveBeenCalled();
    // The opt-in prompt is never even asked when nothing new was added.
    const askedExtract = spies.confirm.mock.calls.some(([q]) => q === EXTRACTION_PROMPT);
    expect(askedExtract).toBe(false);
    const out = joined(logs);
    expect(out).toContain(EXTRACTION_NOTHING_NEW_MESSAGE);
    expect(out).not.toContain(EXTRACTION_OPTIONAL_MESSAGE); // never even offered
    expect(result.steps.find((s) => s.step === 'extract')).toEqual({
      step: 'extract',
      status: 'skipped',
      detail: 'nothing-new',
    });
    expect(result.exitCode).toBe(0);
  });

  it('documents added + user DECLINES the opt-in → no extract call, points at `munin extract`', async () => {
    const { deps, actions, logs } = makeDeps({
      select: async () => 'local',
      addResult: { outcome: 'ingested', documentsAdded: 5 },
      confirm: async (q, d) => (q === EXTRACTION_PROMPT ? false : d),
    });

    const result = await runSetup(deps);

    expect(actions.extract).not.toHaveBeenCalled();
    const out = joined(logs);
    expect(out).toContain(EXTRACTION_OPTIONAL_MESSAGE);
    expect(out).toContain(EXTRACTION_DECLINED_MESSAGE);
    expect(out).not.toContain(GRAPH_BUILT_MESSAGE);
    expect(result.steps.find((s) => s.step === 'extract')).toEqual({
      step: 'extract',
      status: 'skipped',
      detail: 'declined',
    });
    expect(result.exitCode).toBe(0);
  });

  it('documents added + user ACCEPTS the opt-in → extract runs with the do-not-open warning', async () => {
    const { deps, actions, logs } = makeDeps({
      select: async () => 'local',
      addResult: { outcome: 'ingested', documentsAdded: 5 },
      confirm: async (q, d) => (q === EXTRACTION_PROMPT ? true : d),
    });

    const result = await runSetup(deps);

    expect(actions.extract).toHaveBeenCalledOnce();
    const out = joined(logs);
    expect(out).toContain(EXTRACTION_OPTIONAL_MESSAGE);
    // The warning shown right before the blocking run (the full message wraps
    // across lines; assert a single-line fragment of the "don't open" warning).
    expect(out).toContain(BUILDING_GRAPH_MESSAGE);
    expect(out).toContain('do not open your AI client');
    expect(out).toContain(GRAPH_BUILT_MESSAGE);
    expect(result.steps.find((s) => s.step === 'extract')).toEqual({
      step: 'extract',
      status: 'done',
    });
    expect(result.exitCode).toBe(0);
  });
});

describe('runSetup — connect + verify outcomes', () => {
  it('connect written with a backup → reports both the write and the backup path', async () => {
    const { deps, logs } = makeDeps({
      select: async () => 'local',
      connect: connectResult({
        action: 'written',
        targetPath: '/cfg/claude_desktop_config.json',
        backupPath: '/cfg/claude_desktop_config.json.munin-backup-x',
      }),
    });

    const result = await runSetup(deps);

    expect(result.exitCode).toBe(0);
    const out = joined(logs);
    expect(out).toContain('✓ Wrote the `munin` MCP server to /cfg/claude_desktop_config.json');
    expect(out).toContain(
      'backed up the previous config to /cfg/claude_desktop_config.json.munin-backup-x',
    );
  });

  it('connect unchanged (idempotent re-run) → clean', async () => {
    const { deps, logs } = makeDeps({
      select: async () => 'local',
      connect: connectResult({ action: 'unchanged' }),
    });
    const result = await runSetup(deps);
    expect(result.exitCode).toBe(0);
    expect(joined(logs)).toContain('already has the `munin` server — no change.');
  });

  it('connect refused → block printed by hand, exit 1, incomplete message', async () => {
    const { deps, logs, errors } = makeDeps({
      select: async () => 'local',
      connect: connectResult({ action: 'refused', refusalReason: 'unparseable' }),
    });

    const result = await runSetup(deps);

    expect(result.exitCode).toBe(1);
    expect(joined(errors)).toContain('is not valid JSON');
    expect(joined(logs)).toContain('"munin": {}'); // the block, for hand-pasting
    expect(joined(logs)).toContain(SETUP_INCOMPLETE_MESSAGE);
    expect(result.steps.find((s) => s.step === 'connect')?.status).toBe('fail');
  });

  it('doctor shows the store "in use by your AI client" → explained as healthy, exit 0', async () => {
    const { deps, logs } = makeDeps({
      select: async () => 'local',
      doctorChecks: [
        { label: 'MUNIN_HOME resolves', status: 'ok', detail: '/home/u/.munin' },
        {
          label: 'local store',
          status: 'skip',
          detail:
            'in use by your AI client (pid 4242); this is normal while Claude Desktop is running',
        },
      ],
    });

    const result = await runSetup(deps);

    expect(joined(logs)).toContain(STORE_IN_USE_EXPLANATION);
    expect(result.exitCode).toBe(0); // a skip is not a fail
    expect(result.steps.find((s) => s.step === 'verify')).toEqual({
      step: 'verify',
      status: 'done',
      detail: 'in-use',
    });
  });

  it('doctor reports a failing check → exit 1, incomplete message', async () => {
    const { deps, logs } = makeDeps({
      select: async () => 'local',
      doctorChecks: [{ label: 'tenant resolves', status: 'fail', detail: 'no live tenant' }],
    });

    const result = await runSetup(deps);

    expect(result.exitCode).toBe(1);
    expect(joined(logs)).toContain(SETUP_INCOMPLETE_MESSAGE);
    expect(result.steps.find((s) => s.step === 'verify')?.status).toBe('fail');
  });
});
