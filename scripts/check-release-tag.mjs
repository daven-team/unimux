// CI check for tag builds: the tag, every version file of the app (package.json and its lock file, the Cargo workspace and
// its lock file, tauri.conf.json) and the release notes must agree.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readVersions, versionMismatches } from './release-lib.mjs';

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/, 'Release tags look like v1.2.3');
const version = tag.slice(1);
const mismatches = versionMismatches(readVersions(), version);
assert.deepEqual(mismatches, [], `The tag is ${tag}, but:\n  ${mismatches.join('\n  ')}`);

const notesFile = `docs/releases/${version}.md`;
assert.ok(existsSync(notesFile), `Release notes are missing: ${notesFile}`);
const notes = readFileSync(notesFile, 'utf8').replace(/\r\n/g, '\n');
// Existing release notes retain the name and filenames used when they were published.
assert.ok(notes.startsWith(`# unimux ${version}\n`) || notes.startsWith(`# ajzakomator ${version}\n`), `${notesFile} must start with "# unimux ${version}"`);
assert.ok(/^- \S/m.test(notes), `${notesFile} needs at least one bullet point`);
console.log(`Release metadata for ${tag} is consistent (package.json, Cargo.toml, Cargo.lock, tauri.conf.json, notes).`);
