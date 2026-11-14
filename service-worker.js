
const CACHE_NAME = "ziwan-yattra-v1";

const APP_FILES = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

// Firebase SDK
importScripts(
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js"
);

// Firebase configuration
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

// Background notification
messaging.setBackgroundMessageHandler((payload) => {
  const data = payload.data || {};
  const notification = payload.notification || {};

  const title = data.title || notification.title || "ZIWAN YATTRA";

  return self.registration.showNotification(title, {
    body: data.body || notification.body || "A new update is available!",
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

  event.waitUntil(clients.openWindow(targetUrl.href));
});

// Original install system
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES))
  );
  self.skipWaiting();
});

// Original activate system
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Original fetch system
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
