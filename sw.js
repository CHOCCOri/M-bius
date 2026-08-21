/* Möbius Service Worker · notification and push router · local optimized */
'use strict';

const DB_NAME = 'dream-messenger-sw-v1';
const DB_VERSION = 1;
const STORE = 'state';
let preferences = {
  systemNotificationEnabled: true,
  notificationOnlyBackground: false,
  notificationDndEnabled: false,
  notificationDndStart: '22:00',
  notificationDndEnd: '08:00'
};

function openDb() {
  return new Promise(resolve => {
    let request;
    try { request = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (_) { resolve(null); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => resolve(null);
  });
}

async function getState(key, fallback) {
  const db = await openDb();
  if (!db) return fallback;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; try { db.close(); } catch (_) {} resolve(value); };
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => finish(request.result?.value ?? fallback);
      request.onerror = tx.onerror = tx.onabort = () => finish(fallback);
    } catch (_) { finish(fallback); }
  });
}

async function setState(key, value) {
  const db = await openDb();
  if (!db) return false;
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => { if (settled) return; settled = true; try { db.close(); } catch (_) {} resolve(ok); };
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, value, updatedAt: Date.now() });
      tx.oncomplete = () => finish(true);
      tx.onerror = tx.onabort = () => finish(false);
    } catch (_) { finish(false); }
  });
}

function parseMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  return match ? (Number(match[1]) % 24) * 60 + Math.min(59, Number(match[2]) || 0) : 0;
}

function isInDnd(settings) {
  if (!settings.notificationDndEnabled) return false;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const start = parseMinutes(settings.notificationDndStart || '22:00');
  const end = parseMinutes(settings.notificationDndEnd || '08:00');
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function normalizePushPayload(value) {
  const payload = value && typeof value === 'object' ? value : {};
  const receivedAt = Number(payload.receivedAt || payload.createdAt) || Date.now();
  const routeData = payload.routeData && typeof payload.routeData === 'object' ? payload.routeData : (payload.data && typeof payload.data === 'object' ? payload.data : {});
  return {
    ...payload,
    id: String(payload.id || `push-${receivedAt}-${Math.random().toString(36).slice(2)}`),
    title: String(payload.title || 'Möbius'),
    body: String(payload.body || payload.text || '您有一条新消息'),
    route: String(payload.route || routeData.route || 'home'),
    routeData,
    tag: String(payload.tag || `dream-${receivedAt}`),
    createdAt: Number(payload.createdAt) || receivedAt,
    receivedAt
  };
}

async function appendInbox(payload) {
  const inbox = await getState('pushInbox', []);
  const list = Array.isArray(inbox) ? inbox : [];
  if (!list.some(item => item?.id && item.id === payload.id)) list.push(payload);
  await setState('pushInbox', list.slice(-100));
}

function base64UrlToUint8Array(value) {
  const padding = '='.repeat((4 - String(value).length % 4) % 4);
  const base64 = (String(value) + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
}

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    preferences = { ...preferences, ...(await getState('preferences', {})) };
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const message = event.data || {};
  const reply = value => { try { event.ports?.[0]?.postMessage(value); } catch (_) {} };
  if (message.type === 'SKIP_WAITING') {
    event.waitUntil(Promise.resolve(self.skipWaiting()).then(() => reply({ ok: true })));
    return;
  }
  if (message.type === 'CONFIGURE_NOTIFICATIONS') {
    preferences = { ...preferences, ...(message.preferences || {}) };
    event.waitUntil(setState('preferences', preferences).then(ok => reply({ ok })));
    return;
  }
  if (message.type === 'CONFIGURE_PUSH') {
    event.waitUntil(setState('pushConfig', {
      applicationServerKey: message.applicationServerKey || '',
      subscribeEndpoint: message.subscribeEndpoint || ''
    }).then(ok => reply({ ok })));
    return;
  }
  if (message.type === 'DRAIN_PUSH_INBOX') {
    event.waitUntil((async () => {
      const items = await getState('pushInbox', []);
      await setState('pushInbox', []);
      reply({ ok: true, items: Array.isArray(items) ? items : [] });
    })());
    return;
  }
  if (message.type === 'PING') {
    reply({ ok: true, now: Date.now() });
    return;
  }
  reply({ ok: false, error: 'unknown-message' });
});

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let raw = {};
    try { raw = event.data?.json() || {}; }
    catch (_) { raw = { body: event.data?.text() || '您有一条新消息' }; }
    const payload = normalizePushPayload(raw);

    // 不再等待 inbox 完整读写后才显示通知：持久化、客户端投递和系统通知并行进行。
    const inboxPromise = appendInbox(payload);
    const clientsPromise = self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const settingsPromise = getState('preferences', preferences).then(saved => ({ ...preferences, ...(saved || {}) }));
    const [clients, settings] = await Promise.all([clientsPromise, settingsPromise]);
    preferences = settings;

    const clientDelivery = Promise.allSettled(clients.map(client => Promise.resolve().then(() => client.postMessage({ type: 'PUSH_RECEIVED', payload }))));
    const hasVisibleClient = clients.some(client => client.visibilityState === 'visible');
    let notificationPromise = Promise.resolve();
    if (settings.systemNotificationEnabled !== false && !isInDnd(settings) && !(settings.notificationOnlyBackground && hasVisibleClient)) {
      const options = {
        body: payload.body,
        icon: payload.icon || './icons/icon-192.png',
        badge: payload.badge || './icons/badge-96.png',
        tag: payload.tag,
        renotify: payload.renotify !== false,
        requireInteraction: Boolean(payload.requireInteraction),
        timestamp: payload.createdAt,
        data: { id: payload.id, route: payload.route, routeData: payload.routeData, ...payload.routeData }
      };
      notificationPromise = self.registration.showNotification(payload.title, options);
    }
    await Promise.allSettled([inboxPromise, clientDelivery, notificationPromise]);
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const data = event.notification.data || {};
  const route = data.route || 'home';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = windows.find(client => client.visibilityState === 'visible') || windows[0];
    if (target) {
      await target.focus();
      target.postMessage({ type: 'NOTIFICATION_CLICK', route, data: { ...(data.routeData || {}), ...data } });
      return;
    }
    const url = new URL('./', self.registration.scope);
    url.hash = `route=${encodeURIComponent(route)}`;
    await self.clients.openWindow(url.href);
  })());
});

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const config = await getState('pushConfig', {});
    let subscription = null;
    try {
      if (config?.applicationServerKey) {
        subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(config.applicationServerKey)
        });
        if (config.subscribeEndpoint) {
          await fetch(config.subscribeEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ subscription: subscription.toJSON(), scope: self.registration.scope, reason: 'pushsubscriptionchange' })
          });
        }
      }
    } catch (_) { subscription = null; }
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(client => client.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED', resubscribeRequired: !subscription }));
  })());
});
