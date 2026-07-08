// Inbox notification chimes, synthesized with the Web Audio API so we don't need
// to ship any audio assets. Two clearly distinct sounds:
//   • playNewMessage()   → a soft rising two-note "ding" for any new customer message
//   • playHumanWaiting() → a more urgent 4-note pattern when someone is waiting for a human
//
// Browsers block audio until the user interacts with the page, so we lazily
// create the AudioContext and resume it on the first interaction (initAudioUnlock).

let ctx: AudioContext | null = null;

const MUTE_KEY = 'nico_sound_muted';

type Win = Window & { webkitAudioContext?: typeof AudioContext };

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as Win).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

export function isMuted(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(MUTE_KEY) === '1';
}

export function setMuted(muted: boolean): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
}

/** Resume the (suspended) audio context on the first user gesture. Safe to call once on mount. */
export function initAudioUnlock(): void {
  if (typeof window === 'undefined') return;
  const unlock = () => {
    const c = getCtx();
    if (c && c.state === 'suspended') void c.resume();
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

interface Note {
  freq: number;
  start: number; // seconds, relative to now
  dur: number; // seconds
  type?: OscillatorType;
}

function tone(c: AudioContext, n: Note): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = n.type ?? 'sine';
  osc.frequency.value = n.freq;
  osc.connect(gain);
  gain.connect(c.destination);
  const t0 = c.currentTime + n.start;
  // Quick attack, exponential decay — a pleasant percussive chime.
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(0.15, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);
  osc.start(t0);
  osc.stop(t0 + n.dur + 0.03);
}

function play(seq: Note[]): void {
  if (isMuted()) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') void c.resume();
  for (const n of seq) tone(c, n);
}

/** Gentle rising two-note "ding" for a new inbound message. */
export function playNewMessage(): void {
  play([
    { freq: 660, start: 0, dur: 0.18 },
    { freq: 880, start: 0.11, dur: 0.22 },
  ]);
}

/** More urgent, distinct chime for a customer waiting on a human agent. */
export function playHumanWaiting(): void {
  play([
    { freq: 880, start: 0, dur: 0.15, type: 'triangle' },
    { freq: 1175, start: 0.16, dur: 0.15, type: 'triangle' },
    { freq: 880, start: 0.32, dur: 0.15, type: 'triangle' },
    { freq: 1175, start: 0.48, dur: 0.3, type: 'triangle' },
  ]);
}
