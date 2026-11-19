// Installable app: registers the service worker (production builds only, so
// development reloads stay simple) and keeps the browser's install prompt
// so the "Install" banner can show it.
let deferred = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn(Boolean(deferred)));

export function registerServiceWorker() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
}

export const canInstall = () => Boolean(deferred);
export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export async function promptInstall() {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  notify();
  return outcome === 'accepted';
}

// iPhones have no install prompt: they add to the home screen from Share.
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
