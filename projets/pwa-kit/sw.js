// ==========================================
// @siteleap-sw
// Service Worker produit par SiteLeap (à la racine du site client)
// ==========================================

const IDENTIFIANT_SW = "@siteleap-sw";
const CACHE_SOURCES = "siteleap-sources-v1";
const CACHE_AUTRES = "siteleap-autres-v1";
const PROJET_ID = "ID_DU_PROJET";
const URL_ENREGISTRER_STAT = "https://TON-DOMAINE-NETLIFY.netlify.app/.netlify/functions/enregistrer-stat";

const EXTENSIONS_SOURCES = /\.(html?|css|js|mjs|json|png|jpg|jpeg|webp|gif|svg|ico|woff2?)$/i;

self.addEventListener("install", (event) => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    const cachesActifs = [CACHE_SOURCES, CACHE_AUTRES];
    event.waitUntil(
        caches.keys()
            .then((cles) => Promise.all(
                cles
                    .filter((cle) => !cachesActifs.includes(cle))
                    .map((cle) => caches.delete(cle))
            ))
            .then(() => self.clients.claim())
    );
});

async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE_SOURCES);
    const miseEnCache = await cache.match(request);

    const requeteReseau = fetch(request)
        .then((reponseReseau) => {
            if (reponseReseau && reponseReseau.ok) {
                cache.put(request, reponseReseau.clone()).catch(() => {});
            }
            return reponseReseau;
        })
        .catch(() => null);

    return miseEnCache || requeteReseau || Response.error();
}

async function networkFirst(request) {
    const cache = await caches.open(CACHE_AUTRES);
    try {
        const reponseReseau = await fetch(request);
        if (reponseReseau && reponseReseau.ok) {
            cache.put(request, reponseReseau.clone()).catch(() => {});
        }
        return reponseReseau;
    } catch (e) {
        const secours = await cache.match(request);
        return secours || Response.error();
    }
}

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    if (EXTENSIONS_SOURCES.test(url.pathname)) {
        event.respondWith(staleWhileRevalidate(req));
    } else {
        event.respondWith(networkFirst(req));
    }
});

self.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type === "ENREGISTRER_STAT") {
        fetch(URL_ENREGISTRER_STAT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: data.id || PROJET_ID,
                evenement: data.evenement || "ouverture"
            }),
            keepalive: true
        }).catch(() => {});
    }
});
