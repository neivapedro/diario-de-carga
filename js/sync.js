// Sincronização com a conta (Supabase), pensada para funcionar sem internet:
// tudo é salvo primeiro no aparelho; o que mudou fica marcado como pendente
// e sobe quando houver conexão. Em conflito vale a alteração mais recente.

import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const META_KEY = 'diario-de-carga:sync';
const TABLE = 'registros';
const PAGE = 1000;

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'diario-de-carga:auth' },
});

// known: última versão conhecida de cada registro { k: tipo, h: assinatura, t: quando mudou, del }
// dirty: ids alterados no aparelho que ainda não subiram
const emptyMeta = () => ({ user: null, known: {}, dirty: {} });
let meta = loadMeta();

function loadMeta() {
  try { return { ...emptyMeta(), ...JSON.parse(localStorage.getItem(META_KEY) || '{}') }; } catch { return emptyMeta(); }
}
function saveMeta() {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch {}
}

const sign = (data) => {
  const s = JSON.stringify(data);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + s.length.toString(36);
};

function records(state) {
  const out = [];
  for (const w of state.workouts) out.push(['w', w.id, w]);
  for (const s of state.sessions) out.push(['s', s.id, s]);
  if (state.names.length) out.push(['p', 'perfil', { names: state.names }]);
  return out;
}

/* ---------- estado exposto para a tela ---------- */

let status = navigator.onLine ? 'ok' : 'offline';
let listener = () => {};
export const onStatus = (fn) => { listener = fn; };
export const pendingCount = () => Object.keys(meta.dirty).length;
export const getStatus = () => status;
function setStatus(s) { status = s; listener(s); }

/* ---------- registro de mudanças locais ---------- */

export function track(state) {
  const now = Date.now();
  const seen = new Set();
  for (const [k, id, data] of records(state)) {
    seen.add(id);
    const h = sign(data);
    const cur = meta.known[id];
    if (!cur || cur.del || cur.h !== h) {
      meta.known[id] = { k, h, t: now };
      meta.dirty[id] = 1;
    }
  }
  for (const [id, cur] of Object.entries(meta.known)) {
    if (!seen.has(id) && !cur.del && cur.k !== 'p') {
      meta.known[id] = { k: cur.k, h: '', t: now, del: true };
      meta.dirty[id] = 1;
    }
  }
  saveMeta();
}

/* ---------- conta ---------- */

// Liga os dados do aparelho à conta que entrou. Dados feitos antes do
// primeiro login são enviados para a conta.
export function adopt(userId, state) {
  if (meta.user && meta.user !== userId) return false; // aparelho tem dados de outra conta
  meta.user = userId;
  track(state);
  return true;
}

export function resetLocal() {
  meta = emptyMeta();
  saveMeta();
}

/* ---------- envio e recebimento ---------- */

function apply(state, r, t) {
  const list = r.kind === 'w' ? 'workouts' : r.kind === 's' ? 'sessions' : null;
  if (r.kind === 'p') {
    // nomes de exercícios: junta os dois lados em vez de sobrescrever
    const names = [...state.names];
    for (const n of r.data?.names || []) if (!names.includes(n)) names.push(n);
    state.names = names;
    meta.known[r.id] = { k: 'p', h: sign(r.data || { names: [] }), t };
    return;
  }
  if (!list) return;
  const i = state[list].findIndex((x) => x.id === r.id);
  if (r.deleted) {
    if (i >= 0) state[list].splice(i, 1);
    meta.known[r.id] = { k: r.kind, h: '', t, del: true };
  } else {
    if (i >= 0) state[list][i] = r.data; else state[list].push(r.data);
    meta.known[r.id] = { k: r.kind, h: sign(r.data), t };
  }
}

async function pull(state) {
  let rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(TABLE)
      .select('id,kind,data,deleted,updated_at')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < PAGE) break;
  }
  let changed = false;
  for (const r of rows) {
    const t = Number(r.updated_at);
    const kn = meta.known[r.id];
    if (r.kind === 'p') {
      const before = state.names.length;
      apply(state, r, t);
      if (state.names.length !== before) changed = true;
      continue;
    }
    if (kn && kn.t >= t) continue; // a versão do aparelho é igual ou mais nova
    apply(state, r, t);
    delete meta.dirty[r.id];
    changed = true;
  }
  saveMeta();
  return changed;
}

async function push(state, userId) {
  const ids = Object.keys(meta.dirty);
  if (!ids.length) return;
  const byId = new Map(records(state).map(([, id, data]) => [id, data]));
  const rows = ids.filter((id) => meta.known[id]).map((id) => {
    const kn = meta.known[id];
    return {
      user_id: userId,
      id,
      kind: kn.k,
      data: kn.del ? null : byId.get(id) ?? null,
      deleted: !!kn.del,
      updated_at: kn.t,
    };
  });
  const { error } = await sb.from(TABLE).upsert(rows, { onConflict: 'user_id,id' });
  if (error) throw error;
  for (const r of rows) if (meta.known[r.id]?.t === r.updated_at) delete meta.dirty[r.id];
  saveMeta();
}

let running = null;
let again = false;

async function run(state, onChange) {
  if (!navigator.onLine) return setStatus('offline');
  const { data: { session } } = await sb.auth.getSession();
  if (!session || session.user.id !== meta.user) return;
  setStatus('syncing');
  try {
    const changed = await pull(state);
    track(state);
    if (changed) onChange();
    await push(state, session.user.id);
    setStatus(pendingCount() ? 'pending' : 'ok');
  } catch (e) {
    console.warn('sincronização falhou', e);
    setStatus(navigator.onLine ? 'error' : 'offline');
  }
}

// Sincroniza agora. onChange é chamado se chegaram dados de outro aparelho.
export async function syncNow(state, onChange) {
  if (running) { again = true; return running; }
  running = run(state, onChange);
  try {
    await running;
  } finally {
    running = null;
    if (again) { again = false; syncNow(state, onChange); }
  }
}
