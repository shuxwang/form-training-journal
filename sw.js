const CACHE='form-journal-plan8-1';
const ROOT=new URL('./',self.location.href).href;
const FILES=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./cloud-config.js','./sync-core.js','./cloud.js?v=ed7f487a0585'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('form-journal-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET'||!e.request.url.startsWith(ROOT))return;
 if(e.request.mode==='navigate'){
  e.respondWith(fetch(e.request).then(async r=>{if(r.ok){const c=await caches.open(CACHE);await c.put(new URL('./index.html',ROOT),r.clone())}return r}).catch(()=>caches.match(new URL('./index.html',ROOT))));
 }else e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request)));
});
