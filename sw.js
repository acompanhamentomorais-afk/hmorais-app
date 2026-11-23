/* Service worker: guarda o app no celular para abrir sem internet.
   A cada versão nova do app, troque o número em VERSAO (o celular baixa a nova e apaga a antiga). */
const VERSAO = 'hm-app-9';
const ARQUIVOS = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO && k !== 'hm-fontes').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;                                    // envio para o painel: sempre pela internet
  if (url.origin === location.origin) {
    // app: rede primeiro (pega a versão nova), cópia guardada sem internet
    const guardada = () => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'));
    const rede = fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(VERSAO).then(x => x.put(req, c)); } return r; });
    // internet lenta: depois de 4 s abre a cópia guardada (a nova fica para a próxima vez)
    e.respondWith(new Promise(res => {
      let feito = false; const fim = r => { if (!feito && r) { feito = true; res(r); } };
      const t = setTimeout(() => guardada().then(fim), 4000);
      rede.then(r => { clearTimeout(t); fim(r); }).catch(() => { clearTimeout(t); guardada().then(r => fim(r || Response.error())); });
    }));
  } else if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.open('hm-fontes').then(c => c.match(req).then(r => r || fetch(req).then(n => { c.put(req, n.clone()); return n; }))));
  }
});
