// Animation preference. Default "full": the owner wants the full animations even though
// their device asks apps to reduce motion. "system" follows the device; "reduced" calms everything.
export const MOTION_KEY = 'cfm.pref.motion';

export function motionPref() {
  try { return localStorage.getItem(MOTION_KEY) || 'full'; } catch { return 'full'; }
}

export function reducedMotion() {
  const p = motionPref();
  if (p === 'reduced') return true;
  if (p === 'system') return matchMedia('(prefers-reduced-motion: reduce)').matches;
  return false;
}

export function setMotionPref(v) {
  try { localStorage.setItem(MOTION_KEY, v); } catch { /* ignore */ }
  applyMotionClass();
}

/** html.motion-full lets CSS keep its animations even when the device asks for less. */
export function applyMotionClass() {
  const root = document.documentElement;
  root.classList.toggle('motion-full', !reducedMotion());
  root.classList.toggle('motion-calm', motionPref() === 'reduced');
}
