
/* =========================================
   ZIWAN YATTRA - OFFLINE SERVICE WORKER
   Static pages and tools work offline.
   News, AI and Admin require internet.
   Firebase push notifications preserved.
========================================= */

const CACHE_PREFIX = "zy-offline-";
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-v2`;

// Main website files to cache during installation
const PRECACHE_FILES = [
  "/",
  "/index.html",
  "/index2.html",
  "/manifest.json",

  // Icons
  "/icons/favicon-48.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",

  // Images
  "/images/shopping-banner.jpg",

  // Static pages
  "/about.html",
  "/contact.html",
  "/creator-services.html",
  "/daily-tools.html",
  "/disclaimer.html",
  "/education.html",
  "/gaming.html",
  "/government-services.html",
  "/mobile-help.html",
  "/privacy-policy.html",
  "/shopping.html",
  "/technician.html",
  "/ZIWAN-YATTRA-Computer-Tech-Book-Language-Fix.html",
  "/ziwan-yattra-rewards-promo-1.html"
];

// Pages that require internet
const ONLINE_ONLY_PATHS = new Set([
  "/daily-updates.html",
  "/article.html",
  "/ai-knowledge.html",
  "/admin.html"
]);

// Firebase background notifications
importScripts(
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js"
);

firebase.initializeApp({
  apiKey: "AIzaSyCH5b5R2LRUMJCnh00HvbsI35KErb3zjjk",
  authDomain: "ziwan-yattra.firebaseapp.com",
  projectId: "ziwan-yattra",
  storageBucket: "ziwan-yattra.firebasestorage.app",
  messagingSenderId: "932726571298",
  appId: "1:932726571298:web:87735dec31ae2acfaaa57b",
  measurementId: "G-1CPNLKFBPT"
});

const messaging = firebase.messaging();

messaging.setBackgroundMessageHandler((payload) => {
  const data = payload.data || {};
  const notification = payload.notification || {};

  const title =
    data.title ||
    notification.title ||
    "ZIWAN YATTRA";

  return self.registration.showNotification(title, {
    body:
      data.body ||
      notification.body ||
      "A new update is available!",
    icon: "/icons/icon-192.png",
    data: {
      url: data.url || "/"
    }
  });
});

// Notification click
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = new URL(
    event.notification.data?.url || "/",
    self.location.origin
  );

  if (targetUrl.origin !== self.location.origin) return;

  event.waitUntil(
    clients.openWindow(targetUrl.href)
  );
});

// INSTALL
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    await Promise.all(
      PRECACHE_FILES.map(async (file) => {
        try {
          const response = await fetch(file, {
            cache: "reload"
          });

          if (response.ok) {
            await cache.put(file, response);
          }
        } catch (error) {
          console.warn(
            "ZIWAN YATTRA cache skipped:",
            file
          );
        }
      })
    );
  })());

  self.skipWaiting();
});

// ACTIVATE
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter(
          key =>
            key.startsWith(CACHE_PREFIX) &&
            key !== CACHE_NAME &&
            key !== RUNTIME_CACHE
        )
        .map(key => caches.delete(key))
    );

    await clients.claim();
  })());
});

// OFFLINE MESSAGE
function offlinePage() {
  return new Response(`
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport"
        content="width=device-width,initial-scale=1">
      <title>Offline | ZIWAN YATTRA</title>
    </head>
    <body style="
      margin:0;
      font-family:Arial,sans-serif;
      background:#f4f1ff;
      color:#211d35;
      display:grid;
      min-height:100vh;
      place-items:center;
      text-align:center;">
      <main style="padding:28px;max-width:420px">
        <h2>You're offline</h2>
        <p>
          This section needs an internet connection.
          Your saved ZIWAN YATTRA tools and pages
          are still available.
        </p>
        <a href="/index.html" style="
          display:inline-block;
          padding:12px 20px;
          border-radius:12px;
          background:#6d4bd1;
          color:white;
          text-decoration:none;">
          Open Home
        </a>
      </main>
    </body>
    </html>
  `, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

// FETCH HANDLER
self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isNavigation = request.mode === "navigate";

  // Never cache API or share routes
  if (
    url.origin === self.location.origin &&
    (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/share/")
    )
  ) {
    return;
  }

  // Online-only pages
  if (
    url.origin === self.location.origin &&
    ONLINE_ONLY_PATHS.has(url.pathname)
  ) {
    event.respondWith(
      fetch(request).catch(() => offlinePage())
    );
    return;
  }

  // Website pages: network first, cache fallback
  if (
    isNavigation &&
    url.origin === self.location.origin
  ) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);

        if (response && response.ok) {
          const cache = await caches.open(CACHE_NAME);

          await cache.put(
            request,
            response.clone()
          );
        }

        return response;

      } catch (error) {
        const cached =
          await caches.match(request, {
            ignoreSearch: true
          }) ||
          await caches.match(
            url.pathname === "/"
              ? "/index.html"
              : url.pathname
          );

        return cached || offlinePage();
      }
    })());

    return;
  }

  // Same-origin CSS, JS, images and other resources
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(request);

      if (cached) return cached;

      try {
        const response = await fetch(request);

        if (response && response.ok) {
          const cache = await caches.open(RUNTIME_CACHE);

          await cache.put(
            request,
            response.clone()
          );
        }

        return response;

      } catch (error) {
        return Response.error();
      }
    })());

    return;
  }

  // Cache external images and fonts after first successful load
  const isImage = request.destination === "image";

  const isFont =
    request.destination === "font" ||
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com";

  if (isImage || isFont) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);

      const cached = await cache.match(request);

      if (cached) return cached;

      try {
        const response = await fetch(request);

        if (
          response &&
          (response.ok || response.type === "opaque")
        ) {
          await cache.put(
            request,
            response.clone()
          );
        }

        return response;

      } catch (error) {
        return cached || Response.error();
      }
    })());
  }
});
