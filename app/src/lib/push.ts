import { BRAND } from '../brand';
import { api } from './api';

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** iOS only exposes push to installed PWAs — the Settings screen shows an install hint instead. */
export function needsInstallForPush(): boolean {
  return isIOS() && !isStandalone();
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function subscribe(): Promise<boolean> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64urlToUint8(BRAND.vapidPublicKey) as unknown as ArrayBuffer,
  });
  const json = sub.toJSON();
  await api.subscribePush({ endpoint: sub.endpoint, p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' });
  return true;
}

export async function unsubscribe(): Promise<void> {
  const sub = await currentSubscription();
  if (sub) {
    await api.unsubscribePush(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe();
  }
}

function b64urlToUint8(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
