/**
 * Service Worker for Mugdiya Receipts PWA (v2.5)
 * Intercepts Web Share Target POST requests from Android OS and manages offline caching.
 */

const CACHE_NAME = 'mugdiya-receipts-v2.8';
const ASSETS_TO_CACHE = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'vendor/pdf.min.js',
  'vendor/pdf.worker.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('MugdiyaShareDB', 2);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('shared_files')) {
        db.createObjectStore('shared_files', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('staged_session_files')) {
        db.createObjectStore('staged_session_files', { keyPath: 'id' });
      }
    };
    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (err) => reject(err);
  });
}

function storeSharedFiles(files) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('shared_files', 'readwrite');
      const store = tx.objectStore('shared_files');

      if (!files || files.length === 0) {
        resolve();
        return;
      }

      files.forEach((file) => {
        store.add({
          file: file,
          name: file.name,
          type: file.type,
          timestamp: Date.now()
        });
      });

      tx.oncomplete = () => resolve();
      tx.onerror = (err) => reject(err);
    });
  });
}

// Fetch handler - intercepts share-target POST requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.endsWith('/share-target') && event.request.method === 'POST') {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const files = formData.getAll('receipt_images');
          if (files && files.length > 0) {
            await storeSharedFiles(files);
          }
        } catch (err) {
          console.error('Error handling shared files in SW:', err);
        }
        return Response.redirect('./?shared=1', 303);
      })()
    );
    return;
  }

  // Network first with cache fallback
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
