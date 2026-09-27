// Service worker mínimo — só existe pra deixar o Rasmar "instalável" no
// celular (critério técnico do Chrome/Android). Não guarda dados nem
// tenta funcionar offline de verdade (o app depende de sincronizar com o
// servidor o tempo todo) — só serve a própria tela de novo se, por
// algum motivo, o dispositivo estiver sem internet no instante de abrir.
const CACHE_NOME = 'rasmar-v1';
const ARQUIVOS_APP = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE_NOME).then((cache) => cache.addAll(ARQUIVOS_APP)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys().then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE_NOME).map((n) => caches.delete(n))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (evento) => {
  // sempre tenta a rede primeiro (dados têm que ser os mais novos
  // possíveis); só usa o cache se estiver realmente sem internet.
  evento.respondWith(
    fetch(evento.request).catch(() => caches.match(evento.request))
  );
});
