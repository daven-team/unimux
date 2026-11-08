// `npm run check:bundle`: the shipped app carries no Node (PLAN R1, release gate item 3). It inspects what a Tauri bundle
// installs and fails on
//   - a Node runtime (node.exe / node, libnode.*),
//   - a native Node addon (*.node),
//   - JavaScript outside the renderer bundle (*.js / *.mjs / *.cjs files, a node_modules folder, an Electron app.asar):
//     the renderer's JS is embedded in the unimux binary by tauri::generate_context! and never ships as a file.
//
// What it reads, per bundle folder (src-tauri/target[/<triple>]/release/bundle, or the folders / files given):
//   - Windows: every file the NSIS installer installs, from the installer script Tauri generated next to it
//     (release/nsis/<arch>/installer.nsi: the main binary, `File` resources and external binaries, the installer hooks),
//     plus the staged resources folder; an installer without its script fails the check (nothing is run or extracted);
//   - macOS: every file inside each .app (the .dmg holds the same .app; it is not mounted here).
//
//   npm run check:bundle                       every bundle under src-tauri/target
//   npm run check:bundle -- --target <triple>  the bundle of one cross target (CI)
//   npm run check:bundle -- <path> ...         a bundle folder, a .app or an installer.nsi
//
// Exit code 0: clean; 1: forbidden content (listed); 2: nothing to check.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = join(root, 'src-tauri', 'target');

/** Why a shipped path is not allowed, or null. `path` uses forward slashes, relative to the install root. */
export function forbidden(path) {
  const parts = path.split('/');
  const name = parts.at(-1).toLowerCase();
  if (name === 'node.exe' || name === 'node' || /^libnode\./.test(name)) return 'a Node runtime';
  if (name.endsWith('.node')) return 'a native Node addon';
  if (/\.(m|c)?js$/.test(name)) return 'JavaScript outside the renderer bundle';
  if (name === 'app.asar' || name.endsWith('.asar')) return 'an Electron app archive';
  if (parts.some((p) => p.toLowerCase() === 'node_modules')) return 'a node_modules folder';
  return null;
}

/** Every file below `dir`, relative with forward slashes. */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/**
 * The files an NSIS script installs: `File` directives (with `/oname=`), `${DEFINE}`s resolved from its `!define`s, the
 * files of `!include`d scripts (the installer hooks) as well. Paths are install paths with forward slashes.
 */
export function nsisFiles(scriptPath, seen = new Set(), defines = new Map()) {
  if (seen.has(scriptPath)) return [];
  seen.add(scriptPath);
  const text = readFileSync(scriptPath, 'utf8');
  for (const m of text.matchAll(/^\s*!define\s+(\w+)\s+"([^"]*)"/gm)) defines.set(m[1], m[2]);
  const expand = (s) => s.replace(/\$\{(\w+)\}/g, (all, name) => defines.get(name) ?? all);
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    const include = /^\s*!include\s+"([^"]+)"/.exec(line);
    if (include) {
      const file = resolve(dirname(scriptPath), expand(include[1]));
      if (existsSync(file)) files.push(...nsisFiles(file, seen, defines));
      continue;
    }
    const directive = /^\s*File\s+(.*)$/.exec(line);
    if (!directive) continue;
    const args = [...directive[1].matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
    const oname = args.find((a) => a.startsWith('/oname='));
    const source = args.filter((a) => !a.startsWith('/')).at(-1);
    if (!source) continue;
    // A file only unpacked to $TEMP during the install (the WebView2 bootstrapper) is not part of the installed app.
    const target = oname ? expand(oname.slice('/oname='.length)) : basename(expand(source).replace(/\\/g, '/'));
    if (/^\$TEMP\\/i.test(target)) continue;
    files.push(target.replace(/^\$INSTDIR\\?/i, '').replace(/\\/g, '/'));
  }
  return files;
}

/** The bundle folders under src-tauri/target: release/bundle and <triple>/release/bundle. */
function defaultBundles(triple) {
  if (!existsSync(targetDir)) return [];
  const profiles = triple ? [join(targetDir, triple, 'release')] : [join(targetDir, 'release'), ...readdirSync(targetDir).map((d) => join(targetDir, d, 'release'))];
  return [...new Set(profiles)].map((p) => join(p, 'bundle')).filter((b) => existsSync(b) && statSync(b).isDirectory());
}

/** [{what, files: [install path]}] of one argument: a bundle folder, an .app, or an installer.nsi. */
function inspect(path) {
  const out = [];
  const stat = statSync(path);
  if (stat.isFile() && /\.nsi$/i.test(path)) return [{ what: path, files: nsisFiles(path) }];
  if (stat.isDirectory() && /\.app$/i.test(path)) return [{ what: path, files: walk(path) }];
  if (!stat.isDirectory()) throw new Error(`${path}: give a bundle folder, a .app or an installer.nsi`);
  // A bundle folder: bundle/nsis/*.exe (with release/nsis/<arch>/installer.nsi), bundle/macos/*.app, bundle/dmg.
  const release = dirname(path);
  const nsisDir = join(path, 'nsis');
  if (existsSync(nsisDir)) {
    const installers = readdirSync(nsisDir).filter((f) => /\.exe$/i.test(f));
    const scripts = existsSync(join(release, 'nsis')) ? readdirSync(join(release, 'nsis')).map((a) => join(release, 'nsis', a, 'installer.nsi')).filter(existsSync) : [];
    if (installers.length && !scripts.length) throw new Error(`${nsisDir}: no installer.nsi next to the installer (${join(release, 'nsis')}); rebuild the bundle`);
    for (const script of scripts) out.push({ what: `${installers.map((i) => join(nsisDir, i)).join(', ') || nsisDir} (${script})`, files: nsisFiles(script) });
    // What the installer packs from the release folder (bundle.resources are staged there).
    if (existsSync(join(release, 'resources'))) out.push({ what: join(release, 'resources'), files: walk(join(release, 'resources')).map((f) => `resources/${f}`) });
  }
  const macDir = join(path, 'macos');
  if (existsSync(macDir)) for (const app of readdirSync(macDir).filter((f) => /\.app$/i.test(f))) out.push({ what: join(macDir, app), files: walk(join(macDir, app)) });
  if (!out.length) throw new Error(`${path}: no NSIS installer and no .app in this bundle folder`);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const tripleAt = args.indexOf('--target');
  const triple = tripleAt >= 0 ? args[tripleAt + 1] : undefined;
  const paths = args.filter((a, i) => !a.startsWith('--') && (tripleAt < 0 || i !== tripleAt + 1)).map((p) => resolve(p));
  const targets = paths.length ? paths : defaultBundles(triple);
  if (!targets.length) {
    console.error(`no Tauri bundle found under ${targetDir}${triple ? ` for ${triple}` : ''}: run \`npm run build:release\` first (or give a path)`);
    process.exit(2);
  }
  let bad = 0;
  let checked = 0;
  for (const target of targets) {
    let parts;
    try { parts = inspect(target); } catch (error) { console.error(`FAIL ${error.message}`); bad++; continue; }
    for (const { what, files } of parts) {
      const problems = files.map((f) => [f, forbidden(f)]).filter(([, why]) => why);
      checked += files.length;
      if (problems.length) {
        bad += problems.length;
        console.error(`FAIL ${what}:`);
        for (const [file, why] of problems) console.error(`  ${file}: ${why}`);
      } else console.log(`ok   ${what}: ${files.length} files (${files.slice(0, 6).join(', ')}${files.length > 6 ? ', ...' : ''})`);
    }
  }
  if (bad) {
    console.error(`\n${bad} problem(s): the bundle must carry no Node runtime, no .node addon and no JS outside the renderer bundle`);
    process.exit(1);
  }
  console.log(`\nbundle contents clean: ${checked} files, no Node runtime, no .node addon, no JS outside the renderer bundle`);
}
