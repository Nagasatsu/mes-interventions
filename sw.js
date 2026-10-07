// Service worker : garde une copie de l'appli sur le téléphone pour qu'elle
// s'ouvre même sans réseau (la tournée déjà calculée reste consultable).
// Stratégie « réseau d'abord » : toujours la dernière version quand il y a du
// réseau, la copie locale sinon.
//
// GitHub Pages autorise le navigateur à garder chaque fichier 10 minutes sans
// redemander : sans précaution, après une mise à jour, le téléphone peut
// mélanger la nouvelle page et l'ancien code. On demande donc toujours au
// serveur si le fichier a changé (réponse très rapide quand il n'a pas changé).

// Numéro de version : à augmenter à CHAQUE mise en ligne. C'est ce changement
// qui prévient les téléphones où l'appli est restée ouverte qu'il y a du
// nouveau (ils rechargent alors tout seuls). Il s'affiche dans les Réglages.
const CACHE = 'mes-interventions-v14';
const LIBRARIES = 'https://cdnjs.cloudflare.com/ajax/libs/'; // carte (Leaflet) et glisser-déposer (Sortable)
const LEAFLET = `${LIBRARIES}leaflet/1.9.4/`;
const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './js/app.js',
  './js/api.js',
  './js/solver.js',
  './js/address.js',
  './js/sheet.js',
  './js/pages.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  `${LEAFLET}leaflet.min.js`,
  `${LEAFLET}leaflet.min.css`,
  `${LIBRARIES}Sortable/1.15.6/Sortable.min.js`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_FILES.map((file) => new Request(file, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const isOwnFile = url.origin === self.location.origin;
  // adresses, itinéraires et fonds de carte : directement sur le réseau
  if (request.method !== 'GET' || !(isOwnFile || url.href.startsWith(LIBRARIES))) return;

  event.respondWith(
    // les bibliothèques ont un numéro de version dans leur adresse : elles ne changent jamais
    fetch(request, isOwnFile ? { cache: 'no-cache' } : {})
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })),
  );
});
