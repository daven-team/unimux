// Plays alert sounds. Presets are synthesized with WebAudio from the data in shared/soundPresets; the system sound is a
// main-process beep; an own file is read by main (extension and size checked, only the saved path of the event),
// decoded here (no file:// access, no CSP media-src needed).
import type { AlertEventId, SoundChoice } from '../../shared/alerts';
import { getPreset, type SoundPreset } from '../../shared/soundPresets';
import { getS } from './store';

let context: AudioContext | null = null;
/** Decoded own files: an AudioBuffer is not bound to the context that decoded it, so it outlives a closed one. */
const cached = new Map<AlertEventId, { key: string; buffer: AudioBuffer }>();

/**
 * An open AudioContext keeps the engine's audio service running (a process of its own in WebView2) for as long as the app
 * runs: it is closed CLOSE_AFTER_MS after the last sound ended and a new one is made for the next alert.
 */
const CLOSE_AFTER_MS = 10_000;
let closeAt = 0;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
/** Sounds waiting for their context to resume (WebKit holds one 'suspended' until the next user gesture, webkitCompat.ts). */
let resuming = 0;

/** Keeps the context open for `ms` (a sound that plays) and CLOSE_AFTER_MS after it; overlapping sounds keep the latest end. */
function keepOpen(ms: number): void {
  closeAt = Math.max(closeAt, performance.now() + ms + CLOSE_AFTER_MS);
  closeTimer ??= setTimeout(closeIdle, Math.max(0, closeAt - performance.now()));
}

function closeIdle(): void {
  closeTimer = null;
  if (resuming > 0) closeAt = Math.max(closeAt, performance.now() + CLOSE_AFTER_MS);
  if (performance.now() < closeAt) {
    closeTimer = setTimeout(closeIdle, closeAt - performance.now());
    return;
  }
  const ctx = context;
  context = null;
  void ctx?.close().catch(() => { /* already closed */ });
}

async function audio(): Promise<AudioContext> {
  keepOpen(0);
  context ??= new AudioContext();
  const ctx = context;
  if (ctx.state === 'suspended') {
    resuming++;
    try { await ctx.resume(); } finally { resuming--; keepOpen(0); }
  }
  return ctx;
}

async function fileBuffer(event: AlertEventId): Promise<AudioBuffer | null> {
  const loaded = await window.mc.loadAlertSound(event, cached.get(event)?.key);
  if (!loaded.ok) return null;
  if (!loaded.data) return cached.get(event)?.buffer ?? null;
  const ctx = await audio();
  const bytes = loaded.data.buffer.slice(loaded.data.byteOffset, loaded.data.byteOffset + loaded.data.byteLength) as ArrayBuffer;
  const buffer = await ctx.decodeAudioData(bytes);
  cached.set(event, { key: loaded.key, buffer });
  return buffer;
}

/** Plays a preset; returns how long it sounds (ms). */
function playPreset(ctx: AudioContext, preset: SoundPreset, volume: number): number {
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.02;
  let last = t0;
  for (const note of preset.notes) {
    const start = t0 + note.start;
    const end = start + note.duration;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = note.wave;
    osc.frequency.value = note.freq;
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(note.gain, start + note.attack);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(env).connect(master);
    osc.start(start);
    osc.stop(end + 0.05);
    last = Math.max(last, end + 0.05);
  }
  return (last - ctx.currentTime) * 1000;
}

/**
 * Plays one sound choice at the saved volume. Returns false when an own file was chosen but could not be played
 * (the system sound is used instead). `event` selects which saved file is read for `kind: 'file'`.
 */
export async function playAlertSound(event: AlertEventId, choice: SoundChoice, volume = getS().settings.alerts.volume): Promise<boolean> {
  if (choice.kind === 'off') return true;
  if (choice.kind === 'system') {
    window.mc.systemBeep();
    return true;
  }
  if (choice.kind === 'preset') {
    const preset = getPreset(choice.id);
    if (!preset) return true;
    try {
      keepOpen(playPreset(await audio(), preset, volume));
      return true;
    } catch {
      window.mc.systemBeep();
      return false;
    }
  }
  try {
    const buffer = await fileBuffer(event);
    if (buffer) {
      const ctx = await audio();
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.buffer = buffer;
      source.connect(gain).connect(ctx.destination);
      source.start();
      keepOpen(buffer.duration * 1000);
      return true;
    }
  } catch { /* undecodable file: fall back below */ }
  cached.delete(event);
  window.mc.systemBeep();
  return false;
}
