import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type DoctorCheck,
  MCP_TOOL_NAMES,
  allChecksOk,
  inspectClientWiring,
  ollamaModelPresent,
  renderDoctorReport,
  rerankingCheck,
} from './mcp-doctor';

describe('renderDoctorReport', () => {
  it('renders glyphs per status and a header with the home', () => {
    const checks: DoctorCheck[] = [
      { label: 'MUNIN_HOME resolves', status: 'ok', detail: '/home/alice/.munin' },
      { label: 'posture declared', status: 'ok' },
      { label: 'Ollama reachable', status: 'warn', detail: 'not reachable' },
      { label: 'tenant resolves', status: 'fail', detail: 'no live tenant' },
      { label: 'cursor wiring', status: 'skip', detail: 'no config' },
    ];
    const out = renderDoctorReport('/home/alice/.munin', checks);
    expect(out).toContain('munin mcp doctor — home: /home/alice/.munin');
    expect(out).toContain('✓ MUNIN_HOME resolves — /home/alice/.munin');
    expect(out).toContain('! Ollama reachable — not reachable');
    expect(out).toContain('✗ tenant resolves — no live tenant');
    expect(out).toContain('· cursor wiring — no config');
    expect(out).toContain('1 check(s) failed');
  });

  it('summarises all-pass and warnings-only', () => {
    expect(renderDoctorReport('/h', [{ label: 'a', status: 'ok' }])).toContain(
      'All checks passed.',
    );
    expect(
      renderDoctorReport('/h', [
        { label: 'a', status: 'ok' },
        { label: 'b', status: 'warn' },
      ]),
    ).toContain('Ready, with 1 warning(s)');
  });
});

describe('allChecksOk', () => {
  it('true when no check failed (warn/skip tolerated)', () => {
    expect(
      allChecksOk([
        { label: 'a', status: 'ok' },
        { label: 'b', status: 'warn' },
        { label: 'c', status: 'skip' },
      ]),
    ).toBe(true);
  });
  it('false when any check failed', () => {
    expect(allChecksOk([{ label: 'a', status: 'fail' }])).toBe(false);
  });
});

describe('ollamaModelPresent', () => {
  it('matches an exact tagged name', () => {
    expect(ollamaModelPresent('qwen2.5:7b', ['qwen2.5:7b', 'bge-m3:latest'])).toBe(true);
  });

  it('matches a bare request against any pulled tag of that name', () => {
    expect(ollamaModelPresent('bge-m3', ['bge-m3:latest'])).toBe(true);
    expect(ollamaModelPresent('qwen2.5', ['qwen2.5:7b'])).toBe(true);
  });

  it('does NOT treat a mere prefix as present (the runtime-404 false positive)', () => {
    // The bug we fixed: a prefix of the wanted model must not report present.
    expect(ollamaModelPresent('qwen2.5:7b', ['qwen2'])).toBe(false);
    expect(ollamaModelPresent('bge-m3', ['bge'])).toBe(false);
  });

  it('does not match a different tag of the same name', () => {
    expect(ollamaModelPresent('qwen2.5:7b', ['qwen2.5:latest'])).toBe(false);
  });

  it('is false against an empty list', () => {
    expect(ollamaModelPresent('bge-m3', [])).toBe(false);
  });
});

describe('rerankingCheck', () => {
  it('warns and explains the impact when reranking is OFF (RERANK_PROVIDER unset)', () => {
    const c = rerankingCheck({});
    expect(c.status).toBe('warn');
    expect(c.label).toBe('reranking');
    expect(c.detail).toContain('OFF');
    // Names the impact and that it is the top quality knob, so a non-developer gets it.
    expect(c.detail).toMatch(/answer quality is reduced/i);
    expect(c.detail).toMatch(/#1 retrieval-quality knob/);
    // Points at how to turn it on without reading source.
    expect(c.detail).toMatch(/cross-encoder/);
    expect(c.detail).toMatch(/LOCAL-RUNTIME\.md/);
  });

  it('warns when RERANK_PROVIDER is explicitly none (case/space-insensitive)', () => {
    expect(rerankingCheck({ RERANK_PROVIDER: 'none' }).status).toBe('warn');
    expect(rerankingCheck({ RERANK_PROVIDER: '  NONE ' }).status).toBe('warn');
    expect(rerankingCheck({ RERANK_PROVIDER: '' }).status).toBe('warn');
  });

  it('reports ok with the provider id when reranking is configured', () => {
    const c = rerankingCheck({ RERANK_PROVIDER: 'cross-encoder' });
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('cross-encoder');
  });
});

describe('MCP_TOOL_NAMES', () => {
  it('mirrors the five MCP tools', () => {
    expect(MCP_TOOL_NAMES).toHaveLength(5);
    expect(MCP_TOOL_NAMES).toContain('munin_ask');
    expect(MCP_TOOL_NAMES).toContain('munin_retrieve_context');
  });
});

describe('inspectClientWiring (recognises both launcher forms)', () => {
  let tmp: string;
  const HOME = '/home/u/.munin';
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'munin-wiring-')));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const writeConfig = (entry: unknown): string => {
    const p = path.join(tmp, 'claude_desktop_config.json');
    fs.writeFileSync(p, JSON.stringify({ mcpServers: { munin: entry } }, null, 2));
    return p;
  };

  it('skips when there is no config file', () => {
    const r = inspectClientWiring(path.join(tmp, 'absent.json'), HOME);
    expect(r.status).toBe('skip');
    expect(r.detail).toContain('no config at');
  });

  it('skips when there is no `munin` entry', () => {
    const p = path.join(tmp, 'c.json');
    fs.writeFileSync(p, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const r = inspectClientWiring(p, HOME);
    expect(r.status).toBe('skip');
    expect(r.detail).toContain('no `munin` entry');
  });

  it('recognises the INSTALLED-bin form and confirms the bin exists', () => {
    const bin = path.join(tmp, 'mcp', 'dist', 'main.js');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '// bin');
    const p = writeConfig({ command: '/n/bin/node', args: [bin], env: { MUNIN_HOME: HOME } });
    const r = inspectClientWiring(p, HOME);
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('installed munin-mcp bin');
  });

  it('warns when the INSTALLED bin path is missing on disk (stale wiring)', () => {
    const bin = path.join(tmp, 'mcp', 'dist', 'main.js'); // never created
    const p = writeConfig({ command: '/n/bin/node', args: [bin], env: { MUNIN_HOME: HOME } });
    const r = inspectClientWiring(p, HOME);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('installed munin-mcp bin');
    expect(r.detail).toContain('missing path');
  });

  it('recognises the CHECKOUT form and confirms the --dir target exists', () => {
    const mcpDir = path.join(tmp, 'packages', 'mcp');
    fs.mkdirSync(mcpDir, { recursive: true });
    const p = writeConfig({
      command: '/n/bin/node',
      args: ['/n/pnpm.cjs', '--dir', mcpDir, '--silent', 'start'],
      env: { MUNIN_HOME: HOME },
    });
    const r = inspectClientWiring(p, HOME);
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('repo checkout');
  });

  it('warns when the CHECKOUT --dir target is missing (removed checkout)', () => {
    const mcpDir = path.join(tmp, 'gone', 'packages', 'mcp'); // never created
    const p = writeConfig({
      command: 'pnpm',
      args: ['--dir', mcpDir, '--silent', 'start'],
      env: { MUNIN_HOME: HOME },
    });
    const r = inspectClientWiring(p, HOME);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('repo checkout');
    expect(r.detail).toContain('missing path');
  });

  it('reports a hand-edited/unrecognised launcher as ok with a "custom launcher" label', () => {
    // Neither `--dir` nor an absolute .js arg — doctor cannot validate the target,
    // so it does not invent a path to check; it stays ok and names the form.
    const p = writeConfig({ command: 'node', args: ['--foo'], env: { MUNIN_HOME: HOME } });
    const r = inspectClientWiring(p, HOME);
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('custom launcher');
  });

  it('warns on home drift regardless of launcher form', () => {
    const bin = path.join(tmp, 'mcp', 'dist', 'main.js');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '// bin');
    const p = writeConfig({
      command: '/n/bin/node',
      args: [bin],
      env: { MUNIN_HOME: '/some/other/home' },
    });
    const r = inspectClientWiring(p, HOME);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('different home');
  });
});
