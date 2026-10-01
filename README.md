# Diário de Carga

Caderneta de treino de musculação: você monta suas fichas (A, B, C...) à mão
e anota peso × repetições de cada série. Cada sessão vira uma coluna ao lado
das anteriores, para comparar com o que fez da última vez.

App web instalável (PWA). No iPhone: abra o link no Safari,
toque em **Compartilhar → Adicionar à Tela de Início**.

## Estrutura

- `index.html` – página única do app
- `css/style.css` – visual (preto + cimento queimado)
- `js/app.js` – telas e interações
- `js/store.js` – onde os dados são salvos (hoje no aparelho; depois, Supabase)
- `sw.js` – funcionamento sem internet
- `manifest.webmanifest`, `icons/` – instalação na tela de início
