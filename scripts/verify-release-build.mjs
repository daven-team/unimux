import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readVersions, versionMismatches } from './release-lib.mjs';

const { RELEASE_TAG: tag, BUILD_RUN_ID: runId, RELEASE_REPOSITORY: repository } = process.env;
assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/);
assert.match(runId ?? '', /^\d+$/);
assert.ok(repository);
const exec = (command, args) => execFileSync(command, args, { encoding: 'utf8', windowsHide: true }).trim();
const api = path => JSON.parse(exec('gh', ['api', `repos/${repository}/${path}`]));
const commit = exec('git', ['rev-parse', `${tag}^{commit}`]);
const source = JSON.parse(exec('git', ['show', `${tag}:package.json`]));
assert.equal(source.version, tag.slice(1));
// The Tauri version files of the tagged commit too (the binary and the installers carry tauri.conf.json's version).
const mismatches = versionMismatches(readVersions((file) => exec('git', ['show', `${tag}:${file}`])), source.version);
assert.deepEqual(mismatches, [], `version files of ${tag} disagree:\n  ${mismatches.join('\n  ')}`);
assert.ok(existsSync(`docs/releases/${source.version}.md`), 'Release notes are missing');
const run = api(`actions/runs/${runId}`);
assert.equal(run.status, 'completed');
assert.equal(run.conclusion, 'success');
assert.equal(run.name, 'CI');
assert.equal(run.repository.full_name, repository);
assert.equal(run.head_sha, commit, 'Build and tag must point to the same commit');
const { jobs } = api(`actions/runs/${runId}/jobs?per_page=100`);
// The three platform builds keep their 1.1.x job names (PLAN U4); "Release assets" assembled and verified the asset list of
// this run (signatures included) the same way the publish step does.
const expected = ['Release metadata', 'Windows x64', 'macOS Apple Silicon', 'macOS Intel', 'Release assets'];
for (const name of expected) {
  assert.equal(jobs.find(job => job.name === name)?.conclusion, 'success', `${name} did not pass`);
}
// Any other job of the run (for example the quick checks, skipped on tags) must not have failed.
for (const job of jobs.filter(job => !expected.includes(job.name))) {
  assert.ok(['success', 'skipped'].includes(job.conclusion), `${job.name} ended as ${job.conclusion}`);
}
console.log(`Verified ${tag}: release metadata and all three platform builds passed at ${commit}.`);
