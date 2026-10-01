-- Diário de Carga: tabela única onde ficam treinos, sessões e nomes de exercícios.
-- Cada linha pertence a uma conta, e as regras abaixo (RLS) garantem que
-- ninguém lê nem altera os dados de outra pessoa.

create table if not exists public.registros (
  user_id    uuid    not null default auth.uid() references auth.users (id) on delete cascade,
  id         text    not null,
  kind       text    not null check (kind in ('w', 's', 'p')),  -- w = treino, s = sessão, p = perfil
  data       jsonb,
  deleted    boolean not null default false,
  updated_at bigint  not null,                                 -- momento da alteração (ms)
  primary key (user_id, id)
);

alter table public.registros enable row level security;

drop policy if exists "dono lê"     on public.registros;
drop policy if exists "dono cria"   on public.registros;
drop policy if exists "dono altera" on public.registros;

create policy "dono lê" on public.registros
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "dono cria" on public.registros
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "dono altera" on public.registros
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update on public.registros to authenticated;
