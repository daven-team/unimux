// npm run publish-release -- [patch|minor|major|x.y.z] --title "short summary" [--current] [--dry-run]
//
// Releases through the GitHub workflows, never from this machine:
//   1. checks the working tree, branch and release notes, runs the release gates (verify-cli-contract, verify-team-start
//      on the check build), typecheck and tests
//   2. bumps the version, commits "release: X.Y.Z with <title>" and tags vX.Y.Z
//   3. pushes main and the tag together (no force)
//   4. waits for the CI run on the tag (Windows + both Mac builds)
//   5. dispatches "Publish release" with that run and waits for it
//
// --current  the version in package.json is already the one to release (skips the bump)
// --dry-run  validates everything and prints the plan without changing anything
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const bump = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--title') ?? 'patch';
const title = option('--title');
const dryRun = flag('--dry-run');
const current = flag('--current');

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (cmd, cmdArgs, opts = {}) => execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && cmd.endsWith('.cmd') });
const out = (cmd, cmdArgs) => run(cmd, cmdArgs).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => { console.error(`\n✖ ${message}\n`); process.exit(1); };
const step = (message) => console.log(`\n▶ ${message}`);

if (!title) fail('Provide a short summary: --title "status bar and resizable cells"');
if (!/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) fail(`Unknown version "${bump}" (use patch, minor, major or x.y.z)`);

// ── checks ─────────────────────────────────────────────────────────────────
step('Checking the repository');
if (out('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('Release from the main branch.');
run('git', ['fetch', 'origin', 'main', '--tags', '--quiet']);
if (Number(out('git', ['rev-list', '--count', 'HEAD..origin/main'])) > 0) fail('Local main is behind origin/main; pull first.');
try { out('gh', ['auth', 'status']); } catch { fail('Log in with `gh auth login` first.'); }
const repository = out('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);

const pkg = () => JSON.parse(readFileSync('package.json', 'utf8'));
const next = (() => {
  if (current) return pkg().version;
  const [major, minor, patch] = pkg().version.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  return bump;
})();
const tag = `v${next}`;
const notes = `docs/releases/${next}.md`;
const releaseFiles = ['package.json', 'package-lock.json', notes];

if (!existsSync(notes)) fail(`Write the release notes first: ${notes}`);
if (out('git', ['tag', '--list', tag])) fail(`Tag ${tag} already exists. Never reuse or move a published tag; release the next version.`);
// Raw output: out() trims, which would cut the leading status column of the first line (' M file' -> 'M file').
const dirty = run('git', ['status', '--porcelain', '--no-renames']).split('\n').filter(Boolean).map((line) => line.slice(3).replace(/^"|"$/g, ''));
const unexpected = dirty.filter((file) => !releaseFiles.includes(file));
if (unexpected.length) fail(`Commit or stash these files first:\n  ${unexpected.join('\n  ')}`);
console.log(`Releasing ${tag} on ${repository}: "release: ${next} with ${title}"`);

// ── release gates (PLAN X1) ────────────────────────────────────────────────
// The command-line contract of the installed claude / codex CLIs and the background start of team workers, both against the
// app as it ships (the Tauri check build of this commit: npm run build:check). A blocked result (exit code 2: a package has
// not landed) stops the release like a failure. Run in a dry run too, so a release never gets as far as the tag without them.
const GATES = ['scripts/verify-cli-contract.mjs', 'scripts/verify-team-start.mjs'];
// The check build is made from this working tree right here (only the release notes may differ from this commit), never
// taken from whatever an earlier build left in src-tauri/target/check; the gates run on the Tauri target and that binary
// only, whatever MC_APP_TARGET / MC_APP_BINARY the shell still has.
step('Check build of this commit (npm run build:check)');
try { run(NPM, ['run', 'build:check'], { inherit: true }); }
catch { fail('npm run build:check failed. The release gates need the check build of this commit.'); }
const gateEnv = { ...process.env, MC_APP_TARGET: 'tauri' };
delete gateEnv.MC_APP_BINARY;
step(`Release gates: ${GATES.map((g) => g.replace('scripts/', '')).join(', ')}`);
for (const gate of GATES) {
  try { execFileSync(process.execPath, [gate], { stdio: 'inherit', env: gateEnv }); }
  catch (error) { fail(`${gate} ${error.status === 2 ? 'is blocked (a package has not landed)' : 'failed'}. Fix it before releasing.`); }
}

if (dryRun) {
  console.log('\nDry run: checks and release gates passed; would run typecheck and tests, commit, tag, push, wait for CI and publish.');
  process.exit(0);
}

// ── local gate ─────────────────────────────────────────────────────────────
step('Typecheck and tests');
run(NPM, ['run', 'typecheck'], { inherit: true });
run(NPX, ['vitest', 'run'], { inherit: true });

// ── commit, tag, push ──────────────────────────────────────────────────────
if (!current) {
  step(`Bumping the version to ${next}`);
  run(NPM, ['version', next, '--no-git-tag-version'], { inherit: true });
}
run('git', ['add', ...releaseFiles.filter((file) => existsSync(file))]);
if (out('git', ['diff', '--cached', '--name-only'])) run('git', ['commit', '-m', `release: ${next} with ${title}`], { inherit: true });
const sha = out('git', ['rev-parse', 'HEAD']);
run('git', ['tag', tag]);
step(`Pushing main and ${tag}`);
run('git', ['push', '--atomic', 'origin', 'main', tag], { inherit: true });

// ── wait for CI on the tag ─────────────────────────────────────────────────
const json = (cmdArgs) => JSON.parse(out('gh', cmdArgs));
step('Waiting for CI on the tag (Windows, macOS Apple Silicon, macOS Intel)');
let ci;
for (let i = 0; i < 60 && !ci; i++) {
  ci = json(['run', 'list', '--workflow', 'CI', '--branch', tag, '--limit', '5', '--json', 'databaseId,headSha']).find((r) => r.headSha === sha);
  if (!ci) await sleep(5000);
}
if (!ci) fail(`No CI run appeared for ${tag}. Check https://github.com/${repository}/actions`);
try { run('gh', ['run', 'watch', String(ci.databaseId), '--exit-status'], { inherit: true }); }
catch { fail(`CI failed for ${tag}. Fix it in a new commit and release the next patch version; do not move the tag.\nhttps://github.com/${repository}/actions/runs/${ci.databaseId}`); }

// ── publish through the workflow ───────────────────────────────────────────
step('Publishing through the "Publish release" workflow');
const started = Date.now();
run('gh', ['workflow', 'run', 'release.yml', '-f', `tag=${tag}`, '-f', `build_run_id=${ci.databaseId}`]);
let publish;
for (let i = 0; i < 40 && !publish; i++) {
  await sleep(3000);
  publish = json(['run', 'list', '--workflow', 'release.yml', '--limit', '5', '--json', 'databaseId,createdAt']).find((r) => Date.parse(r.createdAt) >= started - 10000);
}
if (!publish) fail('The publish workflow did not start; run it manually from the Actions tab.');
try { run('gh', ['run', 'watch', String(publish.databaseId), '--exit-status'], { inherit: true }); }
catch { fail(`Publishing failed: https://github.com/${repository}/actions/runs/${publish.databaseId}`); }

const assets = json(['release', 'view', tag, '--json', 'assets,url']);
console.log(`\n✔ Published ${tag}: ${assets.url}`);
console.log(`  ${assets.assets.length} assets: ${assets.assets.map((a) => a.name).join(', ')}\n`);
