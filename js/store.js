// Camada de dados. Hoje salva no próprio aparelho (localStorage).
// Na etapa da conta online, esta é a única parte que muda para o Supabase.

const KEY = 'diario-de-carga:v1';
const DRAFT_KEY = 'diario-de-carga:rascunho:';

const empty = () => ({ workouts: [], sessions: [], names: [] });

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export const store = {
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? { ...empty(), ...JSON.parse(raw) } : empty();
    } catch {
      return empty();
    }
  },
  save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  },
  loadDraft(workoutId) {
    try {
      const raw = localStorage.getItem(DRAFT_KEY + workoutId);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  saveDraft(workoutId, draft) {
    try { localStorage.setItem(DRAFT_KEY + workoutId, JSON.stringify(draft)); } catch {}
  },
  clearDraft(workoutId) {
    try { localStorage.removeItem(DRAFT_KEY + workoutId); } catch {}
  },
};
