# Diário de Carga

Caderneta de treino de musculação: você monta suas fichas (A, B, C...) à mão
e anota repetições × peso de cada série. Cada sessão vira uma coluna ao lado
das anteriores, para comparar com o que fez da última vez.

App web instalável (PWA). No iPhone: abra o link no Safari,
toque em **Compartilhar → Adicionar à Tela de Início**.

## Estrutura

- `index.html` – página única do app
- `css/style.css` – visual (preto + cimento queimado)
- `js/app.js` – telas e interações
- `js/store.js` – dados salvos no aparelho
- `js/sync.js` – conta e sincronização com o Supabase (funciona sem internet e envia depois)
- `js/config.js` – endereço e chave publicável do projeto Supabase
- `js/vendor/supabase.js` – biblioteca do Supabase (cópia local para funcionar offline)
- `supabase/schema.sql` – tabela e regras de acesso; rodar uma vez no SQL Editor do Supabase
- `sw.js` – funcionamento sem internet
- `manifest.webmanifest`, `icons/` – instalação na tela de início
