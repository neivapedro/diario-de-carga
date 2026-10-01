import { store, uid } from './store.js';
import { sb, track, adopt, resetLocal, syncNow, onStatus, getStatus, pendingCount } from './sync.js';
import { SITE_URL } from './config.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

let state = store.load();
let draft = null;      // sessão sendo preenchida (nova ou em edição)
let draftFor = null;   // id do treino dono do rascunho
let editMode = false;  // modo de edição da ficha (renomear/ordenar/remover exercícios)
let user = null;       // conta conectada

/* ---------- utilidades ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const todayISO = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};
const fmtDate = (iso) => { const [, m, d] = iso.split('-'); return `${d}/${m}`; };
const fmtDateFull = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

const num = (v) => {
  const n = parseFloat(String(v ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const fmtNum = (n) => (n == null ? '' : String(n).replace('.', ','));

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const blankSets = (n) => Array.from({ length: n }, () => ({ w: '', r: '' }));

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { toastEl.hidden = true; }, 2200);
}

function commit() {
  if (!store.save(state)) toast('Não foi possível salvar no aparelho. Verifique o espaço livre.');
  track(state);
  paintStatus();
  clearTimeout(commit.t);
  commit.t = setTimeout(sync, 800);
}

function sync() {
  if (!user) return;
  syncNow(state, () => {
    store.save(state);
    // não redesenha enquanto a pessoa digita ou tem uma janela aberta
    if (app.contains(document.activeElement) && document.activeElement.matches('input')) return;
    if (document.querySelector('.sheet-wrap')) return;
    render({ keepScroll: true });
  });
}

const STATUS_TXT = {
  ok: 'Sincronizado',
  syncing: 'Sincronizando',
  offline: 'Sem internet',
  error: 'Falha ao sincronizar',
};
function statusText() {
  const n = pendingCount();
  const st = getStatus();
  if (st === 'syncing') return STATUS_TXT.syncing;
  if (n && st !== 'error') return `${n} ${n === 1 ? 'pendente' : 'pendentes'}`;
  return STATUS_TXT[st] || STATUS_TXT.ok;
}
function statusKind() {
  const st = getStatus();
  if (st === 'error') return 'erro';
  if (st === 'offline' || pendingCount()) return 'pend';
  return 'ok';
}
function paintStatus() {
  const el = document.getElementById('sync');
  if (!el) return;
  el.dataset.s = statusKind();
  el.querySelector('.sync-txt').textContent = statusText();
}
onStatus(paintStatus);

const userName = () => user?.user_metadata?.name || user?.email?.split('@')[0] || '';

const getWorkout = (id) => state.workouts.find((w) => w.id === id);
const sessionsOf = (wid) => state.sessions
  .filter((s) => s.workoutId === wid)
  .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);

function rememberName(name) {
  if (!state.names.some((n) => norm(n) === norm(name))) state.names.push(name);
}

/* ---------- folha modal (substitui alert/confirm/prompt) ---------- */

function sheet({ title, text = '', html = '', actions, onMount }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = `
      <div class="sheet-bg" data-r="__cancel"></div>
      <form class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h2>${esc(title)}</h2>
        ${text ? `<p class="sheet-text">${esc(text)}</p>` : ''}
        ${html}
        <div class="sheet-actions">
          ${actions.map((a) => `<button type="${a.primary ? 'submit' : 'button'}" class="btn ${a.kind || ''}" data-r="${a.value}">${esc(a.label)}</button>`).join('')}
        </div>
      </form>`;
    document.body.append(wrap);
    const form = wrap.querySelector('form');
    const values = () => Object.fromEntries([...form.querySelectorAll('[name]')].map((i) => [i.name, i.type === 'password' ? i.value : i.value.trim()]));
    const close = (v) => { wrap.remove(); resolve(v); };
    const primary = actions.find((a) => a.primary);
    form.addEventListener('submit', (e) => { e.preventDefault(); if (primary) close({ action: primary.value, ...values() }); });
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (!b || b.type === 'submit') return;
      close(b.dataset.r === '__cancel' ? null : { action: b.dataset.r, ...values() });
    });
    onMount?.(wrap);
    const first = form.querySelector('input');
    if (first) setTimeout(() => first.focus(), 60);
  });
}

const confirmSheet = (title, text, label) => sheet({
  title, text,
  actions: [
    { label: 'Cancelar', value: 'no' },
    { label, value: 'yes', kind: 'danger', primary: true },
  ],
}).then((r) => r?.action === 'yes');

function workoutSheet(w) {
  return sheet({
    title: w ? 'Renomear treino' : 'Novo treino',
    html: `
      <label class="field"><span>Treino</span>
        <input name="code" maxlength="6" autocomplete="off" autocapitalize="characters" placeholder="A" value="${esc(w?.code || '')}"></label>
      <label class="field"><span>Descrição (opcional)</span>
        <input name="name" maxlength="40" autocomplete="off" placeholder="Peito e tríceps" value="${esc(w?.name || '')}"></label>`,
    actions: [
      { label: 'Cancelar', value: 'cancel' },
      { label: w ? 'Salvar' : 'Criar treino', value: 'ok', primary: true },
    ],
  });
}

function exerciseSheet(current) {
  return sheet({
    title: current ? 'Renomear exercício' : 'Novo exercício',
    html: `
      <label class="field"><span>Nome do exercício</span>
        <input name="name" maxlength="60" autocomplete="off" placeholder="Supino reto" value="${esc(current || '')}"></label>
      <ul class="sugest" role="listbox" aria-label="Exercícios já usados"></ul>`,
    actions: [
      { label: 'Cancelar', value: 'cancel' },
      { label: current ? 'Salvar' : 'Adicionar', value: 'ok', primary: true },
    ],
    onMount(wrap) {
      const input = wrap.querySelector('input[name=name]');
      const list = wrap.querySelector('.sugest');
      const paint = () => {
        const q = norm(input.value);
        const hits = state.names
          .filter((n) => (q ? norm(n).includes(q) && norm(n) !== q : true))
          .sort((a, b) => a.localeCompare(b, 'pt-BR'))
          .slice(0, 8);
        list.innerHTML = hits.map((n) => `<li><button type="button" class="chip" data-name="${esc(n)}">${esc(n)}</button></li>`).join('');
        list.hidden = !hits.length;
      };
      input.addEventListener('input', paint);
      list.addEventListener('click', (e) => {
        const b = e.target.closest('[data-name]');
        if (!b) return;
        input.value = b.dataset.name;
        paint();
        input.focus();
      });
      paint();
    },
  });
}

/* ---------- rascunho da sessão ---------- */

function isDraftEmpty(d) {
  return !d.note && Object.values(d.ex).every((e) => !e.note && e.sets.every((s) => !s.w && !s.r));
}

function syncDraft(w) {
  for (const e of w.exercises) {
    if (!draft.ex[e.id]) draft.ex[e.id] = { sets: blankSets(e.sets), note: '' };
  }
}

function loadNewDraft(w) {
  draft = store.loadDraft(w.id) || { date: todayISO(), note: '', editing: null, ex: {} };
  draft.editing = null;
  if (isDraftEmpty(draft)) draft.date = todayISO();
  draftFor = w.id;
  syncDraft(w);
}

function persistDraft() {
  if (draft && !draft.editing) store.saveDraft(draftFor, draft);
}

function startEditing(w, s) {
  persistDraft();
  draft = { date: s.date, note: s.note || '', editing: s.id, ex: {} };
  for (const e of w.exercises) {
    const en = s.entries[e.id];
    const sets = en ? en.sets.map((x) => ({ w: fmtNum(x.w), r: fmtNum(x.r) })) : [];
    draft.ex[e.id] = { sets: sets.length ? sets : blankSets(e.sets), note: en?.note || '' };
  }
}

function draftEntries(w) {
  const entries = {};
  let filled = false;
  for (const e of w.exercises) {
    const de = draft.ex[e.id];
    if (!de) continue;
    const sets = de.sets.map((s) => ({ w: num(s.w), r: num(s.r) }));
    while (sets.length && sets.at(-1).w == null && sets.at(-1).r == null) sets.pop();
    const note = de.note.trim();
    if (sets.length || note) entries[e.id] = { sets, note };
    if (sets.length) filled = true;
  }
  return { entries, filled };
}

/* ---------- telas ---------- */

function renderCapa() {
  const year = new Date().getFullYear();
  app.innerHTML = `
    <section class="capa">
      <div class="elastico" aria-hidden="true"></div>
      <div class="capa-topo"><span>Nº 01</span><span>${year}</span></div>
      <div class="etiqueta">
        <span class="eyebrow">Registro de séries</span>
        <h1>Diário<br>de Carga</h1>
        <span class="etiqueta-sub">repetições × peso</span>
      </div>
      <div class="dono"><span>Pertence a</span><span class="linha">${esc(userName())}</span></div>
      ${user ? `
      <div class="capa-acoes">
        <button class="btn abrir" data-action="abrir">Abrir</button>
        <button class="link" data-action="sair">Sair</button>
      </div>` : `
      <div class="capa-acoes">
        <button class="btn abrir" data-action="entrar">Entrar</button>
        <button class="link" data-action="criar-conta">Criar conta</button>
      </div>`}
    </section>`;
}

function renderIndice() {
  const rows = state.workouts.map((w) => {
    const ss = sessionsOf(w.id);
    const last = ss.at(-1);
    const meta = [
      `${w.exercises.length} ${w.exercises.length === 1 ? 'exercício' : 'exercícios'}`,
      `${ss.length} ${ss.length === 1 ? 'sessão' : 'sessões'}`,
      last ? `última ${fmtDate(last.date)}` : null,
    ].filter(Boolean).join(' · ');
    return `
      <li><button class="idx-item" data-action="open" data-id="${w.id}">
        <span class="idx-code${w.code.length > 2 ? ' longo' : ''}">${esc(w.code)}</span>
        <span class="idx-txt"><span class="idx-nome">${esc(w.name || 'Treino ' + w.code)}</span><span class="idx-meta">${meta}</span></span>
        <span class="idx-seta" aria-hidden="true">›</span>
      </button></li>`;
  }).join('');

  app.innerHTML = `
    <section class="pagina">
      <header class="topo">
        <button class="link" data-action="capa">‹ Capa</button>
        <button class="sync" id="sync" data-action="conta" data-s="${statusKind()}" aria-label="Conta e sincronização">
          <span class="sync-dot" aria-hidden="true"></span><span class="sync-txt">${statusText()}</span>
        </button>
      </header>
      <h1 class="titulo">Diário de Carga</h1>
      ${state.workouts.length ? `<ol class="idx">${rows}</ol>` : `
        <p class="vazio">Seu diário está em branco. Crie o primeiro treino do jeito que você divide: só A, AB, ABC, ABCDE...</p>`}
      <button class="btn add" data-action="new-workout">+ Novo treino</button>
    </section>`;
}

function renderTreino(w) {
  if (draftFor !== w.id || !draft) loadNewDraft(w);
  syncDraft(w);

  const all = sessionsOf(w.id);
  const past = all.filter((s) => s.id !== draft.editing);
  const nCols = past.length;
  const editing = !!draft.editing;
  const today = todayISO();
  const nowLabel = editing ? 'Editando' : draft.date === today ? 'Hoje' : 'Novo';

  const pastHead = past.map((s) => `
    <th scope="col" class="col"><button class="col-btn" data-action="session" data-id="${s.id}">
      <span class="col-n">Treino ${all.indexOf(s) + 1}</span><span class="col-d">${fmtDate(s.date)}</span>
    </button></th>`).join('');

  const pastNotes = past.map((s) => `<td class="obs-txt">${s.note ? esc(s.note) : '<span class="nada">—</span>'}</td>`).join('');

  const exBlocks = w.exercises.map((e, idx) => {
    const de = draft.ex[e.id];
    const rows = Math.max(de.sets.length, ...past.map((s) => s.entries[e.id]?.sets.length || 0));
    let html = `
      <tr class="ex-head"><th colspan="${nCols + 2}" scope="rowgroup"><div class="ex-nome">
        <span>${esc(e.name)}</span>
        ${editMode ? `<span class="ex-ctl">
          <button class="mini" data-action="ex-up" data-id="${e.id}" ${idx === 0 ? 'disabled' : ''} aria-label="Subir">↑</button>
          <button class="mini" data-action="ex-down" data-id="${e.id}" ${idx === w.exercises.length - 1 ? 'disabled' : ''} aria-label="Descer">↓</button>
          <button class="mini" data-action="ex-rename" data-id="${e.id}">Renomear</button>
          <button class="mini perigo" data-action="ex-remove" data-id="${e.id}">Remover</button>
        </span>` : ''}
      </div></th></tr>`;

    for (let i = 0; i < rows; i++) {
      const cells = past.map((s) => {
        const set = s.entries[e.id]?.sets[i];
        if (!set || (set.w == null && set.r == null)) return '<td class="v"><span class="nada">—</span></td>';
        const rTxt = set.r != null ? `${fmtNum(set.r)}<span class="u">rep</span>` : '';
        const wTxt = set.w != null ? `${fmtNum(set.w)}<span class="u">kg</span>` : '';
        return `<td class="v">${rTxt}${rTxt && wTxt ? '<span class="x">×</span>' : ''}${wTxt}</td>`;
      }).join('');
      const ds = de.sets[i];
      const now = ds ? `
        <div class="par">
          <input class="in-r" data-ex="${e.id}" data-i="${i}" data-k="r" inputmode="numeric" enterkeyhint="next" placeholder="rep" aria-label="${esc(e.name)}, série ${i + 1}, repetições" value="${esc(ds.r)}">
          <span class="x">×</span>
          <input class="in-w" data-ex="${e.id}" data-i="${i}" data-k="w" inputmode="decimal" enterkeyhint="next" placeholder="kg" aria-label="${esc(e.name)}, série ${i + 1}, peso em kg" value="${esc(ds.w)}">
        </div>` : '';
      html += `<tr><th scope="row" class="lbl">Série ${i + 1}</th>${cells}<td class="now">${now}</td></tr>`;
    }

    html += `
      <tr class="ctl"><th class="lbl"></th>${nCols ? `<td colspan="${nCols}"></td>` : ''}
        <td class="now"><div class="series-ctl">
          <button class="mini" data-action="set-minus" data-id="${e.id}" ${de.sets.length <= 1 ? 'disabled' : ''} aria-label="Remover série">−</button>
          <span>série</span>
          <button class="mini" data-action="set-plus" data-id="${e.id}" aria-label="Adicionar série">+</button>
        </div></td></tr>
      <tr class="obs"><th scope="row" class="lbl">Obs.</th>
        ${past.map((s) => { const n = s.entries[e.id]?.note; return `<td class="obs-txt">${n ? esc(n) : '<span class="nada">—</span>'}</td>`; }).join('')}
        <td class="now"><input class="in-obs" data-ex="${e.id}" data-k="note" autocomplete="off" placeholder="anotar..." aria-label="Observação de ${esc(e.name)}" value="${esc(de.note)}"></td></tr>`;
    return html;
  }).join('');

  app.innerHTML = `
    <section class="pagina treino ${editing ? 'is-editing' : ''}">
      <header class="topo">
        <button class="link" data-action="indice">‹ Índice</button>
        <button class="link" data-action="toggle-edit">${editMode ? 'Concluir' : 'Editar ficha'}</button>
      </header>
      <div class="treino-cab">
        <span class="treino-code${w.code.length > 2 ? ' longo' : ''}">${esc(w.code)}</span>
        <div class="treino-txt">
          <h1>${esc(w.name || 'Treino ' + w.code)}</h1>
          <span class="idx-meta">${all.length} ${all.length === 1 ? 'sessão registrada' : 'sessões registradas'}</span>
        </div>
      </div>
      ${editMode ? `<div class="edit-bar">
        <button class="mini" data-action="w-rename">Renomear treino</button>
        <button class="mini perigo" data-action="w-delete">Excluir treino</button>
      </div>` : ''}

      ${w.exercises.length ? `
      <div class="grade-wrap" id="grade">
        <table class="grade">
          <thead>
            <tr>
              <th class="lbl canto" scope="col"></th>
              ${pastHead}
              <th scope="col" class="now now-head">
                <span class="col-n">${nowLabel}</span>
                <input type="date" class="in-date" data-k="date" value="${draft.date}" max="${today}" aria-label="Data do treino">
              </th>
            </tr>
          </thead>
          <tbody>
            <tr class="obs dia"><th scope="row" class="lbl">Obs. do dia</th>${pastNotes}
              <td class="now"><input class="in-obs" data-k="day-note" autocomplete="off" placeholder="ex.: gripado" aria-label="Observação do dia" value="${esc(draft.note)}"></td></tr>
            ${exBlocks}
          </tbody>
        </table>
      </div>` : `
      <p class="vazio">Ficha vazia. Adicione os exercícios deste treino na ordem em que você executa.</p>`}

      <button class="btn add" data-action="ex-add">+ Exercício</button>
    </section>
    ${w.exercises.length ? `
    <div class="barra">
      ${editing ? `
        <button class="btn" data-action="edit-cancel">Cancelar</button>
        <button class="btn forte" data-action="save">Salvar alterações</button>` : `
        <button class="btn forte" data-action="save">Salvar treino</button>`}
    </div>` : ''}`;
}

/* ---------- roteamento ---------- */

function route() {
  if (!user) return { name: 'capa' };
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('t/')) {
    const w = getWorkout(h.slice(2));
    if (w) return { name: 'treino', w };
    return { name: 'indice' };
  }
  if (h === 'indice') return { name: 'indice' };
  return { name: 'capa' };
}

function render({ keepScroll = false } = {}) {
  const r = route();
  const grade = document.getElementById('grade');
  const sx = grade?.scrollLeft;
  const sy = window.scrollY;
  document.body.dataset.view = r.name;
  if (r.name === 'treino') renderTreino(r.w);
  else if (r.name === 'indice') renderIndice();
  else renderCapa();

  const g = document.getElementById('grade');
  if (keepScroll) {
    if (g && sx != null) g.scrollLeft = sx;
    window.scrollTo(0, sy);
  } else {
    if (g) g.scrollLeft = g.scrollWidth;
    window.scrollTo(0, 0);
  }
}

const go = (hash) => {
  if (location.hash.replace(/^#/, '') === hash) render();
  else location.hash = hash;
};

window.addEventListener('hashchange', () => { editMode = false; render(); });

/* ---------- ações ---------- */

const actions = {
  abrir: () => go('indice'),
  entrar: () => loginFlow(),
  'criar-conta': () => signupFlow(),
  conta: () => accountFlow(),
  sair: () => logoutFlow(),
  capa: () => go(''),
  indice: () => go('indice'),
  open: (el) => go('t/' + el.dataset.id),

  async 'new-workout'() {
    const r = await workoutSheet();
    if (r?.action !== 'ok') return;
    if (!r.code) return toast('Dê um nome curto ao treino, como A, B ou C.');
    const w = { id: uid(), code: r.code.toUpperCase(), name: r.name, exercises: [], createdAt: Date.now() };
    state.workouts.push(w);
    commit();
    go('t/' + w.id);
  },

  'toggle-edit'() { editMode = !editMode; render({ keepScroll: true }); },

  async 'w-rename'(_, w) {
    const r = await workoutSheet(w);
    if (r?.action !== 'ok' || !r.code) return;
    w.code = r.code.toUpperCase();
    w.name = r.name;
    commit();
    render({ keepScroll: true });
  },

  async 'w-delete'(_, w) {
    const n = sessionsOf(w.id).length;
    const ok = await confirmSheet(
      `Excluir treino ${w.code}?`,
      `A ficha e ${n} ${n === 1 ? 'sessão registrada' : 'sessões registradas'} serão apagadas. Não dá para desfazer.`,
      'Excluir');
    if (!ok) return;
    state.workouts = state.workouts.filter((x) => x.id !== w.id);
    state.sessions = state.sessions.filter((s) => s.workoutId !== w.id);
    store.clearDraft(w.id);
    draft = null; draftFor = null;
    commit();
    go('indice');
  },

  async 'ex-add'(_, w) {
    const r = await exerciseSheet();
    if (r?.action !== 'ok' || !r.name) return;
    const e = { id: uid(), name: r.name, sets: 4 };
    w.exercises.push(e);
    rememberName(r.name);
    draft.ex[e.id] = { sets: blankSets(e.sets), note: '' };
    commit();
    persistDraft();
    render({ keepScroll: true });
  },

  async 'ex-rename'(el, w) {
    const e = w.exercises.find((x) => x.id === el.dataset.id);
    const r = await exerciseSheet(e.name);
    if (r?.action !== 'ok' || !r.name) return;
    e.name = r.name;
    rememberName(r.name);
    commit();
    render({ keepScroll: true });
  },

  async 'ex-remove'(el, w) {
    const e = w.exercises.find((x) => x.id === el.dataset.id);
    const ok = await confirmSheet(`Remover ${e.name}?`, 'O exercício sai da ficha. As anotações antigas dele deixam de aparecer.', 'Remover');
    if (!ok) return;
    w.exercises = w.exercises.filter((x) => x.id !== e.id);
    commit();
    render({ keepScroll: true });
  },

  'ex-up'(el, w) { move(w, el.dataset.id, -1); },
  'ex-down'(el, w) { move(w, el.dataset.id, 1); },

  'set-plus'(el, w) { changeSets(w, el.dataset.id, 1); },
  'set-minus'(el, w) { changeSets(w, el.dataset.id, -1); },

  async session(el, w) {
    const s = state.sessions.find((x) => x.id === el.dataset.id);
    const n = sessionsOf(w.id).indexOf(s) + 1;
    const r = await sheet({
      title: `Treino ${n} · ${fmtDateFull(s.date)}`,
      actions: [
        { label: 'Fechar', value: 'close' },
        { label: 'Excluir', value: 'delete', kind: 'danger' },
        { label: 'Editar', value: 'edit', primary: true },
      ],
    });
    if (r?.action === 'edit') {
      startEditing(w, s);
      render();
    } else if (r?.action === 'delete') {
      const ok = await confirmSheet(`Excluir treino ${n}?`, `As anotações de ${fmtDateFull(s.date)} serão apagadas. Não dá para desfazer.`, 'Excluir');
      if (!ok) return;
      state.sessions = state.sessions.filter((x) => x.id !== s.id);
      commit();
      render({ keepScroll: true });
      toast('Sessão excluída');
    }
  },

  'edit-cancel'(_, w) {
    loadNewDraft(w);
    render();
  },

  save(_, w) {
    const { entries, filled } = draftEntries(w);
    if (!filled) return toast('Preencha ao menos uma série antes de salvar.');
    if (draft.editing) {
      const s = state.sessions.find((x) => x.id === draft.editing);
      // mantém anotações de exercícios que saíram da ficha
      const kept = Object.fromEntries(Object.entries(s.entries).filter(([id]) => !w.exercises.some((e) => e.id === id)));
      Object.assign(s, { date: draft.date, note: draft.note.trim(), entries: { ...kept, ...entries } });
      commit();
      loadNewDraft(w);
      render();
      toast('Alterações salvas');
    } else {
      state.sessions.push({ id: uid(), workoutId: w.id, date: draft.date, note: draft.note.trim(), entries, createdAt: Date.now() });
      commit();
      store.clearDraft(w.id);
      draft = null;
      loadNewDraft(w);
      render();
      toast('Treino salvo');
    }
  },
};

function move(w, id, dir) {
  const i = w.exercises.findIndex((e) => e.id === id);
  const j = i + dir;
  if (j < 0 || j >= w.exercises.length) return;
  [w.exercises[i], w.exercises[j]] = [w.exercises[j], w.exercises[i]];
  commit();
  render({ keepScroll: true });
}

function changeSets(w, id, delta) {
  const de = draft.ex[id];
  if (delta > 0) de.sets.push({ w: '', r: '' });
  else if (de.sets.length > 1) de.sets.pop();
  if (!draft.editing) {
    const e = w.exercises.find((x) => x.id === id);
    e.sets = de.sets.length; // a próxima sessão já abre com essa quantidade
    commit();
  }
  persistDraft();
  render({ keepScroll: true });
}

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const r = route();
  actions[el.dataset.action]?.(el, r.w);
});

app.addEventListener('input', (e) => {
  const t = e.target;
  if (!draft || !t.dataset.k) return;
  const k = t.dataset.k;
  if (k === 'date') { if (t.value) draft.date = t.value; }
  else if (k === 'day-note') draft.note = t.value;
  else if (k === 'note') draft.ex[t.dataset.ex].note = t.value;
  else draft.ex[t.dataset.ex].sets[+t.dataset.i][k] = t.value;
  persistDraft();
});

// "próximo" do teclado: peso -> repetições -> próxima série
app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('.in-w, .in-r')) return;
  e.preventDefault();
  const inputs = [...app.querySelectorAll('.in-w, .in-r')];
  inputs[inputs.indexOf(e.target) + 1]?.focus();
});

/* ---------- conta ---------- */

const AUTH_ERR = [
  [/invalid login credentials/i, 'E-mail ou senha incorretos.'],
  [/email not confirmed/i, 'Confirme seu e-mail antes de entrar. Procure a mensagem do Supabase na caixa de entrada e no spam.'],
  [/already registered|already been registered/i, 'Este e-mail já tem conta. Use Entrar.'],
  [/password should be at least|weak password/i, 'A senha precisa ter pelo menos 6 caracteres.'],
  [/rate limit|too many/i, 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.'],
  [/unable to validate email|invalid email|email address .* is invalid/i, 'Esse e-mail não parece válido. Confira o endereço.'],
  [/failed to fetch|network|load failed/i, 'Sem internet. Para entrar ou criar conta é preciso estar conectado.'],
];
const authMsg = (e) => (AUTH_ERR.find(([re]) => re.test(e?.message || '')) || [, 'Algo deu errado: ' + (e?.message || 'erro desconhecido')])[1];

const fieldsLogin = (email = '') => `
  <label class="field"><span>E-mail</span>
    <input name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" value="${esc(email)}"></label>
  <label class="field"><span>Senha</span>
    <input name="password" type="password" autocomplete="current-password"></label>`;

async function loginFlow(email = '') {
  const r = await sheet({
    title: 'Entrar',
    html: fieldsLogin(email),
    actions: [
      { label: 'Esqueci a senha', value: 'forgot' },
      { label: 'Entrar', value: 'ok', kind: 'forte', primary: true },
    ],
  });
  if (!r) return;
  if (r.action === 'forgot') return forgotFlow(r.email);
  if (!r.email || !r.password) { toast('Preencha e-mail e senha.'); return loginFlow(r.email); }
  toast('Entrando...');
  const { error } = await sb.auth.signInWithPassword({ email: r.email, password: r.password });
  if (error) { toast(authMsg(error)); return loginFlow(r.email); }
  toastEl.hidden = true;
}

async function signupFlow() {
  const r = await sheet({
    title: 'Criar conta',
    html: `
      <label class="field"><span>Seu nome</span>
        <input name="name" autocomplete="name" maxlength="40"></label>
      <label class="field"><span>E-mail</span>
        <input name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off"></label>
      <label class="field"><span>Senha (mínimo 6 caracteres)</span>
        <input name="password" type="password" autocomplete="new-password" minlength="6"></label>`,
    actions: [
      { label: 'Cancelar', value: 'cancel' },
      { label: 'Criar conta', value: 'ok', kind: 'forte', primary: true },
    ],
  });
  if (r?.action !== 'ok') return;
  if (!r.email || r.password.length < 6) { toast('Preencha o e-mail e uma senha com pelo menos 6 caracteres.'); return signupFlow(); }
  toast('Criando conta...');
  const { data, error } = await sb.auth.signUp({
    email: r.email,
    password: r.password,
    options: { data: { name: r.name }, emailRedirectTo: SITE_URL },
  });
  if (error) return toast(authMsg(error));
  if (data.session) return; // confirmação de e-mail desligada: já entrou
  await sheet({
    title: 'Confirme seu e-mail',
    text: `Enviamos um link para ${r.email}. Toque nele para ativar a conta (veja também o spam). Depois volte ao app e toque em Entrar.`,
    actions: [{ label: 'Entendi', value: 'ok', kind: 'forte', primary: true }],
  });
}

async function forgotFlow(email = '') {
  const r = await sheet({
    title: 'Recuperar senha',
    text: 'Enviaremos um link para você criar uma senha nova.',
    html: `<label class="field"><span>E-mail</span>
      <input name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" value="${esc(email)}"></label>`,
    actions: [
      { label: 'Cancelar', value: 'cancel' },
      { label: 'Enviar link', value: 'ok', kind: 'forte', primary: true },
    ],
  });
  if (r?.action !== 'ok' || !r.email) return;
  const { error } = await sb.auth.resetPasswordForEmail(r.email, { redirectTo: SITE_URL });
  toast(error ? authMsg(error) : 'Link enviado. Confira seu e-mail.');
}

async function newPasswordFlow() {
  const r = await sheet({
    title: 'Nova senha',
    html: `<label class="field"><span>Nova senha (mínimo 6 caracteres)</span>
      <input name="password" type="password" autocomplete="new-password" minlength="6"></label>`,
    actions: [{ label: 'Salvar senha', value: 'ok', kind: 'forte', primary: true }],
  });
  if (!r?.password || r.password.length < 6) return newPasswordFlow();
  const { error } = await sb.auth.updateUser({ password: r.password });
  toast(error ? authMsg(error) : 'Senha alterada.');
}

async function accountFlow() {
  const n = pendingCount();
  const r = await sheet({
    title: userName() || 'Conta',
    text: `${user.email} · ${statusText()}${n ? '. As alterações pendentes sobem sozinhas quando houver internet.' : ''}`,
    actions: [
      { label: 'Sair', value: 'logout', kind: 'danger' },
      { label: 'Sincronizar', value: 'sync' },
      { label: 'Fechar', value: 'close', primary: true },
    ],
  });
  if (r?.action === 'sync') {
    if (!navigator.onLine) return toast('Sem internet no momento.');
    sync();
  } else if (r?.action === 'logout') {
    logoutFlow();
  }
}

async function logoutFlow() {
  const n = pendingCount();
  const ok = n
    ? await confirmSheet(
      'Sair com alterações pendentes?',
      `${n} ${n === 1 ? 'alteração ainda não foi enviada' : 'alterações ainda não foram enviadas'} para a conta. Se sair agora, ${n === 1 ? 'ela será perdida' : 'elas serão perdidas'}.`,
      'Sair mesmo assim')
    : await confirmSheet(
      'Sair da conta?',
      `Seus treinos continuam salvos na conta ${user.email}. Para vê-los de novo, é só entrar.`,
      'Sair');
  if (ok) logout();
}

async function logout() {
  await sb.auth.signOut({ scope: 'local' }).catch(() => {});
  clearDevice();
  user = null;
  go('');
}

// apaga do aparelho os dados da conta (eles continuam salvos na nuvem)
function clearDevice() {
  for (const w of state.workouts) store.clearDraft(w.id);
  state = { workouts: [], sessions: [], names: [] };
  store.save(state);
  resetLocal();
  draft = null; draftFor = null;
}

function onSignedIn(u) {
  const first = !user;
  user = u;
  if (!adopt(u.id, state)) {
    // este aparelho tinha dados de outra conta: troca pelos da conta atual
    clearDevice();
    adopt(u.id, state);
  }
  if (first) {
    if (route().name === 'capa' && location.hash !== '#indice') go('indice');
    else render({ keepScroll: true });
  }
  sync();
}

sb.auth.onAuthStateChange((event, session) => {
  // o Supabase pede para não chamar outras funções dele dentro deste aviso
  setTimeout(() => {
    if (event === 'PASSWORD_RECOVERY') { if (session?.user) onSignedIn(session.user); newPasswordFlow(); return; }
    if (session?.user) {
      if (!user || user.id !== session.user.id) onSignedIn(session.user);
      else user = session.user;
    } else if (event === 'SIGNED_OUT' && user) {
      user = null;
      render();
    }
  }, 0);
});

window.addEventListener('online', sync);
window.addEventListener('offline', () => { syncNow(state, () => {}); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });

try {
  const { data } = await sb.auth.getSession();
  user = data.session?.user ?? null;
} catch {}
if (location.hash.includes('access_token') || location.hash.includes('error_description')) history.replaceState(null, '', location.pathname);
render();
if (user) { adopt(user.id, state) || (clearDevice(), adopt(user.id, state)); sync(); }

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // versão nova publicada: recarrega uma vez para já usar a atualização
  if (navigator.serviceWorker.controller) {
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  }
}
