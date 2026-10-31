// "Install Cortex FM" on the home screen. Uses the browser's own install prompt when it
// offers one; otherwise explains, for this exact browser, how to add it (or why it can't).

let deferred = null;
const listeners = new Set();
const notify = () => listeners.forEach(f => f(installState()));

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; notify(); });
window.addEventListener('appinstalled', () => { deferred = null; notify(); });

export function onInstallChange(f) { listeners.add(f); f(installState()); setTimeout(() => f(installState()), 6000); }

/** Which browser this is, in plain words (shown so you can tell what the phone is using). */
export function browserName() {
  const ua = navigator.userAgent;
  if (/WhatsApp/i.test(ua)) return "WhatsApp's built-in browser";
  if (/Instagram/i.test(ua)) return "Instagram's built-in browser";
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return "Facebook's built-in browser";
  if (/; wv\)|GSA\//i.test(ua)) return 'a built-in app browser';
  if (/SamsungBrowser/i.test(ua)) return 'Samsung Internet';
  if (/EdgA|Edg\//i.test(ua)) return 'Microsoft Edge';
  if (/Firefox|FxiOS/i.test(ua)) return 'Firefox';
  if (/OPR|Opera/i.test(ua)) return 'Opera';
  if (/iPhone|iPad|iPod/i.test(ua)) return /CriOS/i.test(ua) ? 'Chrome on iPhone' : 'Safari';
  if (/Chrome/i.test(ua)) return /Android/i.test(ua) ? 'Chrome on Android' : 'Chrome';
  return 'this browser';
}

/** On Android, a link that opens this page in Chrome (from WhatsApp, Samsung Internet, etc.). */
export function openInChromeLink() {
  if (!/Android/i.test(navigator.userAgent)) return null;
  return `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;end`;
}

export function installState() {
  const ua = navigator.userAgent;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return { kind: 'installed', text: 'Cortex FM is installed on this device.' };
  if (deferred) return { kind: 'prompt', text: 'Add Cortex FM to your home screen. It opens full screen like an app.' };
  const inApp = /WhatsApp|Instagram|FBAN|FBAV|FB_IAB|Line\/|Snapchat|Telegram|LinkedInApp|GSA\/|; wv\)/i.test(ua);
  if (inApp) return { kind: 'help', text: 'This page is open inside another app (like WhatsApp), which can\'t install apps. Tap ⋮ (or the share icon) and choose "Open in Chrome", then install from there.' };
  if (/SamsungBrowser/i.test(ua)) return { kind: 'help', text: 'In Samsung Internet: tap ≡ (bottom right), then "Add page to", then "Home screen".' };
  if (/iPhone|iPad|iPod/i.test(ua)) return { kind: 'help', text: 'On iPhone or iPad: open this page in Safari, tap the Share button, then "Add to Home Screen".' };
  if (/Firefox/i.test(ua)) return { kind: 'help', text: 'In Firefox: tap ⋮, then "Install" or "Add to Home screen".' };
  if (/Android/i.test(ua)) return { kind: 'help', text: 'In Chrome: tap ⋮ (top right), then "Add to Home screen" and choose "Install". If you don\'t see it, wait a few seconds and reload the page once.' };
  return { kind: 'help', text: 'In Chrome or Edge on a computer: click the install icon at the right end of the address bar, or ⋮ → "Install Cortex FM".' };
}

/** Show the browser's install dialog if it offered one. Returns true when installed. */
export async function promptInstall() {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  e.prompt();
  const choice = await e.userChoice.catch(() => ({ outcome: 'dismissed' }));
  notify();
  return choice.outcome === 'accepted';
}
