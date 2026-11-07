// The update window part of the golden corpus (1.2.0, PLAN U2), used by scripts/dump-goldens.mjs:
//
//   test/golden/update-progress.jsonl  {baseline, steps: [[elapsedMs, closed, installed, ready, dirBytes|null], ...],
//                                       out: [[stage, percent, note|null], ...]} -> UpdateProgressModel (src/shared/updateProgress.ts)
//                                       fed the steps in order; plus one {closeAction: {stage: action}} row
//   test/golden/update-strings.json    {language: UpdateStrings} as `updateStrings()` of src/main/index.ts builds them (its source
//                                       is evaluated with tr = translate(language)), plus `failed` (the Tauri window's own text
//                                       for a failed install, an existing catalog key)
//   test/golden/update-config.json     a work/config.json exactly as 1.1.4's showUpdateWindow (src/main/updateSplash.ts) writes
//                                       it, which the 1.2.0 update window must read (the protocol is shared)
//
// Scenarios are seeded (mulberry32), so the files are reproducible: the old app exits early, late or never; the installer
// empties and refills the install dir, touches nothing, or the size is not sampled; it ends or never ends; the new app
// reports ready or not; ticks of 250 ms (the window's TICK) with jitter, or coarser ones to reach the 8 / 15 / 60 s notes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rng } from './goldens-normalize.mjs';

const LANGUAGES = ['pl', 'en', 'de', 'es', 'fr', 'pt'];

export function updateProgressRows({ UpdateProgressModel, closeAction }) {
  const r = rng(1301);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const rows = [];
  for (let i = 0; i < 160; i++) {
    const baseline = pick([0, 1, 1000, 11_200_000, 15_400_000, 15_400_000, 300_000_000]);
    const step = pick([250, 250, 250, 1000, 4000]);
    const closeAt = r() < 0.1 ? Infinity : r() < 0.3 ? r() * 1200 : r() * 14000;
    const installAt = r() < 0.15 ? Infinity : closeAt + pick([500, 3000, 20000, 70000]) * r();
    const readyAt = r() < 0.2 ? Infinity : installAt + r() * 9000;
    // How the installer moves the install dir: the valley it empties to (fraction of the baseline) and where it refills to.
    const valley = pick([1, 0.95, 0.85, 0.5, 0.1, 0, 0]);
    const refill = pick([1, 1, 0.73, 0.4]);
    const sampled = r() < 0.85;
    const zeroBytes = r() < 0.05;
    const model = new UpdateProgressModel(baseline);
    const steps = [];
    const out = [];
    let t = 0;
    while (steps.length < 140) {
      t += step + (step === 250 ? Math.floor(r() * 40) - 10 : 0);
      if (step === 4000 && steps.length > 100) t += 60000;
      const closed = t >= closeAt;
      const installed = t >= installAt;
      const ready = t >= readyAt;
      let dirBytes = null;
      if (closed && sampled && r() < 0.7) {
        if (zeroBytes) dirBytes = 0;
        else {
          const since = t - closeAt;
          const span = Number.isFinite(installAt) ? Math.max(1, installAt - closeAt) : 40000;
          const phase = Math.min(1, since / span);
          // Down to the valley in the first third, back up to the refill level after it.
          const fraction = phase < 0.33 ? 1 - (1 - valley) * (phase / 0.33) : valley + (refill - valley) * ((phase - 0.33) / 0.67);
          dirBytes = Math.round(baseline * fraction);
        }
      }
      const snapshot = { elapsedMs: t, closed, installed, ready };
      if (dirBytes !== null) snapshot.dirBytes = dirBytes;
      const p = model.update(snapshot);
      steps.push([t, closed, installed, ready, dirBytes]);
      out.push([p.stage, p.percent, p.note ?? null]);
      if (ready && r() < 0.3) break;
    }
    rows.push({ baseline, steps, out });
  }
  const stages = ['checking', 'ask', 'downloading', 'failed', 'preparing', 'closing', 'installing', 'launching', 'done', 'error'];
  rows.push({ closeAction: Object.fromEntries(stages.map((s) => [s, closeAction(s)])) });
  return rows;
}

/** `updateStrings()` of src/main/index.ts, evaluated from its source for every language. */
export function updateStringsGolden({ root, translate }) {
  const source = readFileSync(resolve(root, 'src/main/index.ts'), 'utf8');
  const match = /const updateStrings = \(\): UpdateStrings => (\(\{[\s\S]*?\n\}\));/.exec(source);
  if (!match) throw new Error('updateStrings() not found in src/main/index.ts');
  const build = new Function('tr', 'getUpdateState', `return ${match[1]};`);
  const version = '1.2.1';
  const out = {};
  for (const language of LANGUAGES) {
    const tr = (key, params) => translate(language, key, params);
    out[language] = { ...build(tr, () => ({ version })), failed: tr('Nie udało się zainstalować aktualizacji.') };
  }
  return { version, strings: out };
}

/** The config 1.1.4's showUpdateWindow writes (key order and all), with the Polish texts. */
export function updateConfigGolden({ strings }) {
  const update = 'C:\\Users\\u\\AppData\\Roaming\\unimux\\update';
  const { failed: _failed, ...pl } = strings.strings.pl;
  return {
    version: strings.version,
    fromVersion: '1.1.4',
    oldPid: 4242,
    installDir: 'C:\\Users\\u\\AppData\\Local\\Programs\\unimux',
    appExe: 'C:\\Users\\u\\AppData\\Local\\Programs\\unimux\\unimux.exe',
    installedFlag: `${update}\\installer-done`,
    readyFlag: `${update}\\ready`,
    shownFlag: `${update}\\work\\shown`,
    abortFlag: `${update}\\work\\abort`,
    heartbeatFlag: `${update}\\work\\heartbeat`,
    runtimeDir: `${update}\\runtime`,
    workDir: `${update}\\work`,
    timeoutMs: 5 * 60 * 1000,
    strings: pl,
  };
}
