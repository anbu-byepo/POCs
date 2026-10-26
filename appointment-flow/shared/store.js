// One demo state shared by the patient app and the clinic app. It lives in
// localStorage, so two tabs (or the two iframes of the split view) on the same
// origin see each other's changes through the "storage" event -- a stand-in
// for the real backend. Every write runs the rules engine against the
// simulated clock before saving.

import { runEngine } from "./flow.js";
import { SCENARIOS } from "./seed.js";

const KEY = "ninto-appt-flow-v1";
const listeners = new Set();
let cache = null;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(state) {
  cache = state;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private mode or blocked storage: the demo still works in this tab.
  }
}

function emit() {
  for (const fn of listeners) fn();
}

export function getState() {
  const stored = load();
  if (stored) return (cache = stored);
  if (cache) return cache;
  const fresh = SCENARIOS.morning.build();
  runEngine(fresh);
  save(fresh);
  return fresh;
}

// Read-modify-write against the freshest copy, so the other tab's last write
// isn't lost. Returns whatever fn returns.
export function update(fn) {
  const draft = structuredClone(getState());
  const result = fn(draft);
  runEngine(draft);
  save(draft);
  emit();
  return result;
}

export function loadScenario(name) {
  const fresh = SCENARIOS[name].build();
  const prev = cache ?? load();
  // Keep the clinic's settings across resets -- they're what's being tested.
  if (prev?.settings) fresh.settings = { ...fresh.settings, ...prev.settings };
  runEngine(fresh);
  save(fresh);
  emit();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

window.addEventListener("storage", event => {
  if (event.key === KEY) {
    cache = null;
    emit();
  }
});
