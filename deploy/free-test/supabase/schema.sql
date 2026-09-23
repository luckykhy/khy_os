-- khy-os free-test schema for Supabase Postgres.
-- Run in Supabase SQL Editor, or: supabase db push (with migrations).
-- Test only: blank DB + minimal seed. No historical data migration.
-- RLS is ON but permissive for the test anon role; tighten before any real use.

create table if not exists instruments (
  id          bigint generated always as identity primary key,
  symbol      text not null unique,
  name        text,
  type        text,
  market      text,
  category    text,
  status      text default 'active',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists watchlist (
  id             bigint generated always as identity primary key,
  user_id        bigint default 0,
  symbol         text not null,
  symbol_name    text,
  instrument_type text,
  category       text,
  base_price     numeric(18,4),
  created_at     timestamptz default now(),
  unique (user_id, symbol)
);

create table if not exists strategies (
  id          bigint generated always as identity primary key,
  name        text,
  code        text,
  params      jsonb default '{}'::jsonb,
  status      text default 'draft',
  user_id     bigint default 0,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists backtests (
  id           bigint generated always as identity primary key,
  strategy_id  bigint,
  result       jsonb,
  status       text default 'done',
  user_id      bigint default 0,
  created_at   timestamptz default now()
);

create table if not exists settings (
  key         text primary key,
  value       jsonb,
  updated_at  timestamptz default now()
);

create table if not exists feedback (
  id          bigint generated always as identity primary key,
  body        text,
  contact     text,
  created_at  timestamptz default now()
);

create table if not exists announcements (
  id          bigint generated always as identity primary key,
  title       text,
  body        text,
  created_at  timestamptz default now()
);

-- RLS: enable but allow all for the test anon/service roles.
alter table instruments     enable row level security;
alter table watchlist        enable row level security;
alter table strategies      enable row level security;
alter table backtests        enable row level security;
alter table settings        enable row level security;
alter table feedback        enable row level security;
alter table announcements   enable row level security;

create policy instruments_all  on instruments   for all using (true);
create policy watchlist_all     on watchlist    for all using (true);
create policy strategies_all    on strategies   for all using (true);
create policy backtests_all     on backtests    for all using (true);
create policy settings_all      on settings     for all using (true);
create policy feedback_all      on feedback     for all using (true);
create policy announcements_all on announcements for all using (true);

-- Seed: 8 default instruments (mirrors services/backend/src/server.js block).
insert into instruments (symbol, name, type, market, category)
values
  ('sh000300','沪深300','index','SSE','指数'),
  ('sh000001','上证指数','index','SSE','指数'),
  ('sz399001','深证成指','index','SZSE','指数'),
  ('sz399006','创业板指','index','SZSE','指数'),
  ('rb_main','螺纹钢主力','futures','SHFE','期货'),
  ('rb2510','螺纹钢2510','futures','SHFE','期货'),
  ('sh600519','贵州茅台','stock','SSE','A股'),
  ('sh600036','招商银行','stock','SSE','A股')
on conflict (symbol) do nothing;

-- Seed: default admin watchlist (user_id 0 = test admin).
insert into watchlist (user_id, symbol, symbol_name, instrument_type, category, base_price)
values
  (0,'sh000300','沪深300','index','指数',4660),
  (0,'sh000001','上证指数','index','指数',3350),
  (0,'sz399001','深证成指','index','指数',10800),
  (0,'sz399006','创业板指','index','指数',3380),
  (0,'sh600519','贵州茅台','股票','A股',1680),
  (0,'sh600036','招商银行','股票','A股',38)
on conflict (user_id, symbol) do nothing;

-- Seed: one template strategy so /api/strategies is non-empty.
insert into strategies (name, code, params, status, user_id)
values (
  '螺纹钢高频模板',
  'if (rsi < 30) buy; if (rsi > 70) sell;',
  '{"period":"rb_main","rsi_period":14,"stop_loss":0.02}'::jsonb,
  'draft', 0
)
on conflict do nothing;

-- Seed: default settings.
insert into settings (key, value)
values
  ('khyos', '{"name":"khy-os free-test","version":"1.1.15","mode":"test"}'::jsonb),
  ('llm',   '{"provider":"openrouter","model":"openai/gpt-4o-mini"}'::jsonb)
on conflict (key) do update set value = excluded.value;

-- Seed: an announcement so the UI has something to show.
insert into announcements (title, body)
values ('欢迎来到 khy-os 测试环境','这是一个全免费 Supabase + GitHub Pages 测试部署,数据为空白库 + 种子。');
