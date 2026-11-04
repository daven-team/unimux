// The weekly dependency report (.github/workflows/deps-report.yml): major updates Dependabot skips (dependabot.yml ignores
// semver-major) and npm audit advisories, as Markdown. Writes an empty file when there is nothing to report.
// Usage: node scripts/deps-report.mjs <npm outdated --json> <npm audit --json> <out.md>
import { readFileSync, writeFileSync } from 'node:fs';

const [outdatedPath, auditPath, outPath] = process.argv.slice(2);
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8') || '{}'); } catch { return {}; } };
const major = (v) => Number(String(v ?? '').replace(/^[^\d]*/, '').split('.')[0]);

const pkg = readJson(new URL('../package.json', import.meta.url));
const outdated = readJson(outdatedPath);
const majors = Object.entries(outdated)
  .map(([name, info]) => ({ name, current: info.current ?? info.wanted, wanted: info.wanted, latest: info.latest, dev: !!pkg.devDependencies?.[name] }))
  .filter((p) => p.latest && p.current && major(p.latest) > major(p.current))
  .sort((a, b) => a.name.localeCompare(b.name));

const order = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
const vulns = Object.values(readJson(auditPath).vulnerabilities ?? {})
  .map((v) => {
    const advisories = (v.via ?? []).filter((x) => typeof x === 'object');
    const f = v.fixAvailable;
    // npm sometimes "fixes" by going back to an ancient major (electron-builder 20); that is no fix.
    const installed = pkg.dependencies?.[f?.name] ?? pkg.devDependencies?.[f?.name];
    const fix = f === true ? 'npm audit fix' : f && typeof f === 'object' && !(installed && major(f.version) < major(installed)) ? `${f.name}@${f.version}${f.isSemVerMajor ? ' (major)' : ''}` : 'no newer fix yet';
    const links = [...new Map(advisories.map((a) => [a.url, `[${a.title}](${a.url})`])).values()].join('<br>') || `via ${(v.via ?? []).join(', ')}`;
    return { name: v.name, severity: v.severity, range: v.range, direct: v.isDirect, fix, links };
  })
  .sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.name.localeCompare(b.name));

const lines = [];
if (vulns.length) {
  lines.push(`## Advisories (${vulns.length})`, '', '| Package | Severity | Affected | Direct | Fix | Advisory |', '| --- | --- | --- | --- | --- | --- |');
  for (const v of vulns) lines.push(`| ${v.name} | ${v.severity} | \`${v.range}\` | ${v.direct ? 'yes' : 'no'} | ${v.fix} | ${v.links} |`);
  lines.push('');
}
if (majors.length) {
  lines.push(`## Major updates (${majors.length})`, '', 'Dependabot does not open pull requests for these; they need a manual migration.', '', '| Package | Current | Latest | Kind |', '| --- | --- | --- | --- |');
  for (const p of majors) lines.push(`| ${p.name} | ${p.current} | ${p.latest} | ${p.dev ? 'dev' : 'runtime'} |`);
  lines.push('');
}
if (lines.length) lines.push(`_Updated ${new Date().toISOString().slice(0, 10)} by the Dependency report workflow._`);
writeFileSync(outPath, lines.join('\n'));
console.log(`${vulns.length} advisories, ${majors.length} major updates`);
