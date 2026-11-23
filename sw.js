/* network-first so new versions and a fresh ipos.json show up; falls back to cache offline */
var C="ipo-ticker-v2";
self.addEventListener("install",function(e){self.skipWaiting();e.waitUntil(caches.open(C).then(function(c){return c.addAll(["./","index.html","manifest.json","icon-192.png","icon-512.png"])}).catch(function(){}))});
self.addEventListener("activate",function(e){e.waitUntil(caches.keys().then(function(k){return Promise.all(k.filter(function(x){return x!==C}).map(function(x){return caches.delete(x)}))}).then(function(){return self.clients.claim()}))});
self.addEventListener("fetch",function(e){var r=e.request;if(r.method!=="GET"||new URL(r.url).origin!==location.origin)return;/* logos from IPO Ji use the browser's own cache */
e.respondWith(fetch(r).then(function(res){if(res.ok){var cp=res.clone();caches.open(C).then(function(c){c.put(r,cp)}).catch(function(){})}return res}).catch(function(){return caches.match(r)}))});
