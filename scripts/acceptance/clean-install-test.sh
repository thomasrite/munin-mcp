#!/usr/bin/env bash
# Clean-install acceptance test for the Munin open-core PUBLIC package set.
#
# Proves a STRANGER WITH NO REPO CHECKOUT can install and run the local product
# from the SINGLE documented command (`npm install munin-mcp`): it packs the 8
# public packages, then installs into a CLEAN temp dir OUTSIDE the repo (so module
# resolution can never reach the source tree) with `munin-mcp` as the ONLY
# top-level dependency — so the separate MCP server package `@muninhq/mcp` must be
# pulled in TRANSITIVELY by munin-mcp's declared deps (step 3 asserts this). It
# then runs — from that install — `munin --help`, `munin init`, `munin status`, a
# boot of the `munin-mcp` server far enough to confirm the PGlite store opens and
# the 17 SQL migrations apply FROM THE INSTALLED package location, and finally
# `munin mcp connect --write`, asserting the emitted client launcher points at the
# INSTALLED `munin-mcp` bin (node_modules/@muninhq/mcp/dist/main.js) — NOT a repo
# checkout path — which proves the whole "stranger wires their AI client" loop.
#
# Usage:
#   bash scripts/acceptance/clean-install-test.sh
#   KEEP=1 bash scripts/acceptance/clean-install-test.sh   # keep temp dirs on exit
#
# Requires: node >=20, pnpm, npm, and network access to the npm registry (the
# engine's third-party runtime deps — pglite, drizzle, SDKs — are fetched there,
# exactly as a real install would). No Ollama / API keys needed: init/status/MCP
# boot make no model calls.
#
# Exit 0 = the public set installs and runs checkout-free. Non-zero = a failure,
# with the offending step named.

set -euo pipefail

# ---- locate the repo (this script may run from anywhere) -------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# The 8 PUBLIC packages, by workspace dir and package name (keep in sync with NOTICE).
PUBLIC_DIRS=(
  "packages/shared"
  "packages/engine"
  "packages/connectors/filesystem"
  "packages/configurations/generic-baseline"
  "packages/configurations/personal"
  "packages/configurations/generic-demo"
  "packages/cli"
  "packages/mcp"
)
PUBLIC_NAMES=(
  "@muninhq/shared"
  "@muninhq/engine"
  "@muninhq/connector-filesystem"
  "@muninhq/config-generic-baseline"
  "@muninhq/config-personal"
  "@muninhq/config-generic-demo"
  "munin-mcp"
  "@muninhq/mcp"
)

# ---- scratch space, OUTSIDE the repo ---------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/munin-acceptance.XXXXXX")"
STAGING="$WORK/tarballs"
CLEAN="$WORK/clean-project"
HOME_DIR="$WORK/munin-home"
mkdir -p "$STAGING" "$CLEAN"

cleanup() {
  local code=$?
  # Best-effort: stop a stray MCP server.
  [ -n "${MCP_PID:-}" ] && kill "$MCP_PID" 2>/dev/null || true
  if [ "${KEEP:-0}" = "1" ]; then
    echo "KEEP=1 — leaving scratch dir: $WORK"
  else
    rm -rf "$WORK"
  fi
  exit $code
}
trap cleanup EXIT

step() { echo ""; echo "==== $* ===="; }
fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "  ok: $*"; }

# ---- 1. build + pack the 8 public packages ---------------------------------
step "1. Build + pack the 8 public packages -> $STAGING"
# `pnpm pack` runs each package's `prepack` (= build), so dist is always fresh.
# We pack ONLY the public set explicitly — never `pnpm -r` (that would build the
# private web app too).
for i in "${!PUBLIC_DIRS[@]}"; do
  dir="$REPO_ROOT/${PUBLIC_DIRS[$i]}"
  name="${PUBLIC_NAMES[$i]}"
  ( cd "$dir" && pnpm pack --pack-destination "$STAGING" >/dev/null )
  ok "packed $name"
done
# (The node step below maps each package name to its tarball by globbing $STAGING,
#  so no bash-4 associative array is needed — keeps this runnable on macOS bash 3.2.)

# ---- 2. synthesise a clean consumer project (SINGLE top-level dep) ---------
step "2. Write a clean consumer project at $CLEAN (no repo access)"
# This models the real install command the README documents: `npm install -g
# munin-mcp` — ONE package. So the consumer's `dependencies` names ONLY `munin-mcp`
# (the user-facing CLI). Everything else — including the SEPARATE MCP server
# package `@muninhq/mcp` — must be pulled in TRANSITIVELY by munin-mcp's own
# declared dependencies; if munin-mcp forgot to declare @muninhq/mcp, the server
# would simply be absent and step 8 (`munin mcp connect`) could not resolve it.
#
# We still pin every public package's local tarball in `overrides`, so the
# inter-package `@muninhq/x: 0.1.0` specifiers inside the tarballs resolve to the
# local tarballs (not the not-yet-published registry version). The overrides only
# REDIRECT a version that is actually depended upon — they do NOT add a dependency
# — so a package reaches node_modules only if something in the dependency graph
# rooted at `munin-mcp` actually requires it. Third-party deps come from npm.
node - "$CLEAN/package.json" "${PUBLIC_NAMES[@]}" <<'NODE' "$STAGING"
const fs = require('node:fs');
const path = require('node:path');
const [outPath, ...rest] = process.argv.slice(2);
const staging = rest.pop();
const names = rest;
const tarballOf = (name) => {
  const base = name.replace('@muninhq/', 'muninhq-');
  const tgz = fs.readdirSync(staging).find((f) => f.startsWith(base + '-') && f.endsWith('.tgz'));
  if (!tgz) throw new Error('missing tarball for ' + name);
  return 'file:' + path.join(staging, tgz);
};
// Pin every public package in overrides (so file: tarballs win over the registry)...
const overrides = {};
for (const name of names) overrides[name] = tarballOf(name);
// ...but depend on ONLY munin-mcp at the top level: the single-install path.
const pkg = {
  name: 'munin-clean-install-acceptance',
  version: '0.0.0',
  private: true,
  type: 'module',
  dependencies: { 'munin-mcp': tarballOf('munin-mcp') },
  overrides,
};
fs.writeFileSync(outPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('  wrote ' + outPath + ' — ONE top-level dep (munin-mcp) + ' + Object.keys(overrides).length + ' tarball overrides');
NODE

# ---- 3. install into the clean project (real npm, from tarballs + registry) -
step "3. npm install into the clean project (this fetches third-party deps)"
( cd "$CLEAN" && npm install --no-audit --no-fund --loglevel=error )
ok "npm install completed"

BIN_MUNIN="$CLEAN/node_modules/.bin/munin"
BIN_MCP="$CLEAN/node_modules/.bin/munin-mcp"
[ -x "$BIN_MUNIN" ] || fail "munin bin not installed/executable at $BIN_MUNIN"
[ -x "$BIN_MCP" ]   || fail "munin-mcp bin not installed/executable at $BIN_MCP"
ok "both bins present: munin, munin-mcp"

# The decisive single-install proof: @muninhq/mcp was NEVER a top-level dep — it is
# present in node_modules ONLY because munin-mcp declares it as a runtime dependency.
MCP_PKG="$CLEAN/node_modules/@muninhq/mcp/package.json"
[ -f "$MCP_PKG" ] || fail "@muninhq/mcp not installed transitively — munin-mcp must declare it as a runtime dependency (single-install path broken)"
node -e "const d=require('$CLEAN/node_modules/munin-mcp/package.json').dependencies||{}; if(!d['@muninhq/mcp']){console.error('FAIL: installed munin-mcp manifest does not declare @muninhq/mcp');process.exit(1)} console.log('  munin-mcp declares @muninhq/mcp@'+d['@muninhq/mcp']+' — server pulled in by the single install')"
ok "@muninhq/mcp resolved via munin-mcp's declared dependency (single 'npm install munin-mcp' pulls the server)"

# Prove the migrations shipped INSIDE the installed engine package (not a checkout).
ENG_MIG="$CLEAN/node_modules/@muninhq/engine/dist/db/migrations"
sql_count="$(ls "$ENG_MIG"/*.sql 2>/dev/null | wc -l | tr -d ' ')"
[ "$sql_count" = "17" ] || fail "expected 17 SQL migrations in the installed engine, found $sql_count at $ENG_MIG"
[ -f "$ENG_MIG/meta/_journal.json" ] || fail "Drizzle meta/_journal.json missing from the installed engine migrations"
ok "installed engine ships all 17 migrations + meta/_journal.json (from the package, not the repo)"

# From here on, run FROM THE CLEAN DIR. Node module resolution starts here and can
# never walk into the repo (it lives elsewhere on disk).
cd "$CLEAN"

# ---- 4. munin --help -------------------------------------------------------
step "4. munin --help"
help_out="$("$BIN_MUNIN" --help)"
echo "$help_out" | grep -q "munin init" || fail "munin --help did not list 'munin init'"
echo "$help_out" | grep -q "munin status" || fail "munin --help did not list 'munin status'"
ok "munin --help prints usage"

# ---- 5. munin init (into a temp MUNIN_HOME) --------------------------------
step "5. munin init --home $HOME_DIR  (opens PGlite + runs migrations from the install)"
init_out="$("$BIN_MUNIN" init --home "$HOME_DIR")"
echo "$init_out" | grep -q "Munin home ready" || { echo "$init_out"; fail "munin init did not report 'Munin home ready'"; }
[ -f "$HOME_DIR/munin.env" ] || fail "munin init did not write $HOME_DIR/munin.env"
grep -q "MUNIN_TENANT_ID=" "$HOME_DIR/munin.env" || fail "munin.env missing MUNIN_TENANT_ID"
grep -q "MUNIN_CONFIG_PACKAGE=@muninhq/config-personal" "$HOME_DIR/munin.env" || fail "munin.env missing the default config package"
# The PGlite data dir must exist and be non-empty — proof migrations actually ran.
pgdir="$(node -e "const {muninHomeLayout}=require('@muninhq/shared');process.stdout.write(muninHomeLayout(process.argv[1]).pgliteDataDir)" "$HOME_DIR")"
[ -d "$pgdir" ] && [ -n "$(ls -A "$pgdir" 2>/dev/null)" ] || fail "PGlite data dir not populated at $pgdir (migrations did not run from the install)"
ok "munin init provisioned the home; PGlite store opened and migrated from the installed package"

# ---- 6. munin status -------------------------------------------------------
step "6. munin status --home $HOME_DIR  (no LLM call)"
status_out="$("$BIN_MUNIN" status --home "$HOME_DIR")"
echo "$status_out" | grep -qiE "document|paragraph|entit|tenant|config" || { echo "$status_out"; fail "munin status output did not look like a corpus-health report"; }
ok "munin status reported corpus health from the installed store"

# ---- 7. boot munin-mcp far enough to confirm store + migrations from install -
step "7. boot munin-mcp (confirm PGlite opens + migrations apply from the install)"
MCP_LOG="$WORK/mcp.stderr.log"
: > "$MCP_LOG"
# The MCP server reads MUNIN_HOME, opens the local store (running migrations from
# the installed engine), loads the config, builds the read-only tools, then logs
# 'listening on stdio' to STDERR (stdout is the JSON-RPC channel). It makes no
# model call at boot, so no Ollama/keys are needed. We spawn it, wait for the
# readiness line, then stop it.
MUNIN_HOME="$HOME_DIR" "$BIN_MCP" >/dev/null 2>>"$MCP_LOG" &
MCP_PID=$!
booted=0
for _ in $(seq 1 60); do
  if grep -qE "listening on stdio|munin-mcp runtime ready" "$MCP_LOG"; then booted=1; break; fi
  if ! kill -0 "$MCP_PID" 2>/dev/null; then break; fi   # process died early
  sleep 0.5
done
kill "$MCP_PID" 2>/dev/null || true
wait "$MCP_PID" 2>/dev/null || true
MCP_PID=""
if [ "$booted" != "1" ]; then
  echo "---- munin-mcp stderr ----"; cat "$MCP_LOG" >&2 || true
  fail "munin-mcp did not reach 'listening on stdio' (store/migrations failed to open from the install)"
fi
grep -q "munin-mcp runtime ready" "$MCP_LOG" || true
ok "munin-mcp booted: PGlite store opened and migrations applied from the installed package"

# ---- 8. munin mcp connect --write points at the INSTALLED bin (not a checkout) -
step "8. munin mcp connect --write  (assert the launcher points at the installed munin-mcp bin)"
CLIENT_CFG="$WORK/claude_desktop_config.json"
# Print/merge the client block into a temp config WE control (never the real OS
# path). connect does NOT open the store — it only emits the launcher block — so
# this is safe to run right after the MCP boot. --home is the temp home from step 5.
connect_out="$("$BIN_MUNIN" mcp connect --client claude-desktop --write \
  --home "$HOME_DIR" --config-path "$CLIENT_CFG" 2>&1)" \
  || { echo "$connect_out"; fail "munin mcp connect --write exited non-zero"; }
[ -f "$CLIENT_CFG" ] || { echo "$connect_out"; fail "connect --write did not create $CLIENT_CFG"; }

# The decisive assertions — parse the written block and prove it is the INSTALLED
# form: the launcher runs the installed @muninhq/mcp dist bin directly, carries no
# `--dir` checkout marker, and references NO repo path anywhere.
node - "$CLIENT_CFG" "$CLEAN" "$REPO_ROOT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [cfgPath, cleanDir, repoRoot] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const entry = cfg.mcpServers && cfg.mcpServers.munin;
if (!entry) { console.error('FAIL: no mcpServers.munin entry written'); process.exit(1); }
const args = Array.isArray(entry.args) ? entry.args : [];
const raw = JSON.stringify(entry);
// It must NOT be the dev checkout launcher.
if (args.includes('--dir')) { console.error('FAIL: launcher uses --dir (checkout form): ' + raw); process.exit(1); }
if (raw.includes(repoRoot)) { console.error('FAIL: launcher references the repo path (' + repoRoot + '): ' + raw); process.exit(1); }
// It MUST run the installed @muninhq/mcp bin, inside the clean install's node_modules.
const bin = args.find((a) => typeof a === 'string' && a.endsWith('/@muninhq/mcp/dist/main.js'));
if (!bin) { console.error('FAIL: no installed munin-mcp bin in args: ' + raw); process.exit(1); }
if (!fs.existsSync(bin)) { console.error('FAIL: installed bin path does not exist on disk: ' + bin); process.exit(1); }
// Compare REALPATHS — `require.resolve` realpaths its result, and on macOS the
// temp dir lives behind the /var -> /private/var symlink, so the logical $CLEAN
// would never prefix-match the resolved bin without this.
const cleanNm = fs.realpathSync(path.join(cleanDir, 'node_modules'));
if (!fs.realpathSync(bin).startsWith(cleanNm)) {
  console.error('FAIL: bin is not under the clean install node_modules: ' + bin); process.exit(1);
}
// The command is the absolute Node binary (pinned), never a bare "pnpm".
if (entry.command === 'pnpm') { console.error('FAIL: command is bare pnpm (checkout fallback)'); process.exit(1); }
if (!path.isAbsolute(entry.command)) { console.error('FAIL: command is not an absolute Node path: ' + entry.command); process.exit(1); }
console.log('  installed-bin launcher: ' + entry.command + ' ' + bin);
NODE
ok "connect --write emitted the INSTALLED-bin launcher (no --dir, no repo path) — the loop closes"

step "ACCEPTANCE PASSED — the public set installs and runs with NO repo checkout"
echo "  bins:        munin, munin-mcp (compiled JS, node shebang — no tsx at runtime)"
echo "  migrations:  17 SQL + meta journal resolved from node_modules/@muninhq/engine/dist/db/migrations"
echo "  PGlite WASM: resolved from the installed @electric-sql/pglite dependency"
echo "  wiring:      munin mcp connect --write → launcher runs the installed munin-mcp bin (no checkout)"
