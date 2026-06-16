-- Tabela de vistorias (inspeção visual à frota) para a app de Gestão de Avarias.
-- Executar UMA vez no Supabase: projeto → SQL Editor → New query → colar → Run.
-- Sem esta tabela, as vistorias funcionam apenas localmente (não são partilhadas).

create table if not exists public.avarias_vistorias (
  id text primary key,
  date date,
  time text,
  company text,
  location text,
  inspector text,
  driver text,
  plate text,
  equipment text,
  equipment_type text,
  items jsonb default '[]'::jsonb,
  score integer default 0,
  result text,
  created_at timestamptz default now(),
  created_by text
);

-- Permitir leitura/escrita com a chave pública (anon), tal como nas restantes tabelas da app.
alter table public.avarias_vistorias enable row level security;

drop policy if exists "avarias_vistorias_all" on public.avarias_vistorias;
create policy "avarias_vistorias_all"
  on public.avarias_vistorias
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- Ativar sincronização em tempo real (realtime).
alter publication supabase_realtime add table public.avarias_vistorias;
