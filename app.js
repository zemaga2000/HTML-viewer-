import { prepareHtml, makeOffline, extractTitle, looksLikeHtml } from './html.js';

// ---------- armazenamento (IndexedDB, só neste telemóvel) ----------

const DB_NAME = 'html-viewer';
const META = 'meta';
const BODY = 'html';

const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore(META, { keyPath: 'id' });
    req.result.createObjectStore(BODY, { keyPath: 'id' });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function run(stores, mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const db = {
  list: () => run([META], 'readonly', (t) => reqP(t.objectStore(META).getAll())),
  html: (id) => run([BODY], 'readonly', (t) => reqP(t.objectStore(BODY).get(id))).then((r) => r?.html ?? ''),
  put: (meta, html) =>
    run([META, BODY], 'readwrite', (t) => {
      t.objectStore(META).put(meta);
      if (html !== undefined) t.objectStore(BODY).put({ id: meta.id, html });
    }),
  remove: (id) =>
    run([META, BODY], 'readwrite', (t) => {
      t.objectStore(META).delete(id);
      t.objectStore(BODY).delete(id);
    }),
};

// Pede ao Safari para não apagar os dados por falta de espaço
navigator.storage?.persist?.().catch(() => {});

// ---------- estado e UI ----------

const $ = (id) => document.getElementById(id);
let docs = [];
let currentBlobUrl = null;
let currentDoc = null;

const byteSize = (s) => new Blob([s]).size;
const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const fmtDate = (ts) => {
  try { return new Date(ts).toLocaleDateString('pt-PT', { day: 'numeric', month: 'short' }); }
  catch { return new Date(ts).toISOString().slice(0, 10); }
};
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const stripExt = (n) => (n ? n.replace(/\.html?$/i, '') : undefined);

function render() {
  docs.sort((a, b) => b.updatedAt - a.updatedAt);
  $('sub').textContent = docs.length
    ? `${docs.length} ${docs.length === 1 ? 'ficheiro' : 'ficheiros'} no telemóvel`
    : 'Os teus ficheiros, sempre disponíveis offline';
  $('empty').hidden = docs.length > 0;

  const list = $('list');
  list.textContent = '';
  for (const d of docs) {
    const offline = d.externals === 0;
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'button');
    card.innerHTML = `
      <div class="ic">&lt;/&gt;</div>
      <div class="info">
        <div class="name"></div>
        <div class="meta">
          <span class="dot" style="background:var(${offline ? '--ok' : '--warn'})"></span>
          <span style="color:var(${offline ? '--ok' : '--warn'})">${offline ? 'Offline' : 'Precisa de internet'}</span>
          <span>&nbsp;·&nbsp;${fmtDate(d.updatedAt)}&nbsp;·&nbsp;${fmtSize(d.size)}</span>
        </div>
      </div>
      <button class="more" aria-label="Opções">•••</button>`;
    card.querySelector('.name').textContent = d.name;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.more')) showActions(d);
      else openDoc(d);
    });
    let pressTimer;
    card.addEventListener('touchstart', () => { pressTimer = setTimeout(() => showActions(d), 550); }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach((ev) => card.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true }));
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); showActions(d); });
    list.appendChild(card);
  }
}

function busy(text) {
  $('busyText').textContent = text || '';
  $('busyScrim').hidden = !text;
}

async function withBusy(label, task) {
  busy(label);
  try { return await task(); }
  catch (e) { alert(`Algo correu mal: ${e?.message ?? e}`); }
  finally { busy(null); }
}

// ---------- importar ----------

async function importHtml(raw, nameHint) {
  const { html, externals } = await prepareHtml(raw);
  const now = Date.now();
  const meta = {
    id: newId(),
    name: extractTitle(html) || nameHint || 'Sem título',
    createdAt: now,
    updatedAt: now,
    size: byteSize(html),
    externals,
  };
  await db.put(meta, html);
  docs.push(meta);
  render();
  return meta;
}

function afterImport(doc) {
  if (doc.externals === 0) return openDoc(doc);
  const open = confirm(
    `Guardado, mas não 100% offline: ${doc.externals} recurso(s) não foram descarregados ` +
      '(sem rede, ou módulos que não dá para embutir).\n\nCom internet, usa ••• → "Tornar offline".\n\nAbrir agora?',
  );
  if (open) openDoc(doc);
}

$('btnImport').addEventListener('click', () => $('file').click());

$('file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const done = await withBusy('A preparar para offline…', async () => {
    let last = null;
    for (const f of files) last = await importHtml(await f.text(), stripExt(f.name));
    return files.length === 1 ? last : null;
  });
  if (done) afterImport(done);
});

async function savePasted(text) {
  if (!text || !looksLikeHtml(text)) {
    alert('Isto não parece HTML. Copia o código completo (na app do Claude, abre o ficheiro e usa "Copiar").');
    return;
  }
  const stamp = new Date().toLocaleString('pt-PT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const doc = await withBusy('A preparar para offline…', () => importHtml(text, `Colado a ${stamp}`));
  if (doc) afterImport(doc);
}

$('btnPaste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) return savePasted(text);
  } catch {
    // sem permissão de leitura do clipboard: usa a caixa manual
  }
  $('pasteArea').value = '';
  $('pasteScrim').hidden = false;
  setTimeout(() => $('pasteArea').focus(), 50);
});
$('pasteCancel').addEventListener('click', () => ($('pasteScrim').hidden = true));
$('pasteOk').addEventListener('click', () => {
  $('pasteScrim').hidden = true;
  savePasted($('pasteArea').value);
});

// ---------- visualizar ----------

async function openDoc(doc) {
  const html = await db.html(doc.id);
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  currentDoc = doc;
  $('vtitle').textContent = doc.name;
  $('frame').src = currentBlobUrl;
  $('viewer').hidden = false;
  document.body.style.overflow = 'hidden';
  history.pushState({ viewer: true }, '');
}

function closeViewer(fromHistory = false) {
  if ($('viewer').hidden) return;
  $('viewer').hidden = true;
  $('frame').src = 'about:blank';
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = null;
  currentDoc = null;
  document.body.style.overflow = '';
  if (!fromHistory && history.state?.viewer) history.back();
}

$('back').addEventListener('click', () => closeViewer());
$('reload').addEventListener('click', () => currentDoc && openDocInPlace(currentDoc));
window.addEventListener('popstate', () => closeViewer(true));

async function openDocInPlace(doc) {
  const html = await db.html(doc.id);
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  $('frame').src = currentBlobUrl;
}

// ---------- ações ----------

function showActions(doc) {
  const g = $('sheetGroup');
  g.textContent = '';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = doc.name;
  g.appendChild(title);

  const add = (label, fn, cls) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', () => { $('sheetScrim').hidden = true; fn(); });
    g.appendChild(b);
  };

  add('Renomear', async () => {
    const name = prompt('Novo nome', doc.name)?.trim();
    if (!name) return;
    doc.name = name;
    await db.put(doc);
    render();
  });
  if (doc.externals > 0) add('Tornar offline', () => retryOffline(doc));
  if (navigator.canShare) add('Partilhar ficheiro', () => shareDoc(doc));
  add('Apagar', async () => {
    if (!confirm(`Apagar "${doc.name}" deste telemóvel?`)) return;
    await db.remove(doc.id);
    docs = docs.filter((d) => d.id !== doc.id);
    render();
  }, 'danger');

  $('sheetScrim').hidden = false;
}

$('sheetCancel').addEventListener('click', () => ($('sheetScrim').hidden = true));
$('sheetScrim').addEventListener('click', (e) => { if (e.target === $('sheetScrim')) $('sheetScrim').hidden = true; });

async function retryOffline(doc) {
  await withBusy('A descarregar recursos…', async () => {
    const { html, externals } = await makeOffline(await db.html(doc.id));
    Object.assign(doc, { externals, size: byteSize(html), updatedAt: Date.now() });
    await db.put(doc, html);
    render();
    alert(externals === 0 ? 'Pronto: já funciona sem internet.' : `Ainda há ${externals} recurso(s) que precisam de internet.`);
  });
}

async function shareDoc(doc) {
  const html = await db.html(doc.id);
  const safe = doc.name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'ficheiro';
  const file = new File([html], `${safe}.html`, { type: 'text/html' });
  if (!navigator.canShare({ files: [file] })) return alert('Este dispositivo não permite partilhar ficheiros.');
  try { await navigator.share({ files: [file], title: doc.name }); } catch { /* cancelado */ }
}

// ---------- instalação ----------

const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
let hideInstall = false;
try { hideInstall = localStorage.getItem('hideInstall') === '1'; } catch {}
$('install').hidden = standalone || hideInstall;
$('installClose').addEventListener('click', () => {
  $('install').hidden = true;
  try { localStorage.setItem('hideInstall', '1'); } catch {}
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------- arranque ----------

db.list().then((list) => {
  docs = list;
  render();
});
