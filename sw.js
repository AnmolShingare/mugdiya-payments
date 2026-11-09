/**
 * Service Worker for Mugdiya Receipts PWA
 * Intercepts Web Share Target POST requests from Android OS and caches assets.
 */

const CACHE_NAME = 'mugdiya-receipts-v2';
const ASSETS_TO_CACHE = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
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

function storeSharedFiles(files) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('MugdiyaShareDB', 1);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('shared_files')) {
        db.createObjectStore('shared_files', { keyPath: 'id', autoIncrement: true });
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      const tx = db.transaction('shared_files', 'readwrite');
      const store = tx.objectStore('shared_files');
      
      let pending = files.length;
      if (pending === 0) {
        resolve();
        return;
      }

      files.forEach((file) => {
        const item = {
          file: file,
          name: file.name,
          type: file.type,
          timestamp: Date.now()
        };
        store.add(item);
      });

      tx.oncomplete = () => resolve();
      tx.onerror = (err) => reject(err);
    };

    request.onerror = (err) => reject(err);
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
