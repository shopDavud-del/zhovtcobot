-- Таблицы бота. Доступ только через service role (RLS включён, политик нет).

create table settings (key text primary key, value text not null);

create table sessions (
  key text primary key,
  data jsonb not null default '{}',
  updated_at timestamptz default now()
);

create table products (
  id bigint generated always as identity primary key,
  title text,
  price bigint,
  term_days int,
  photos text[] not null default '{}',
  media_group_id text unique,
  status text not null default 'draft',   -- draft | scheduled | published | hidden
  publish_at timestamptz,
  reminded boolean not null default false,
  channel_msg_id bigint,
  created_by bigint,
  created_at timestamptz default now()
);

create table orders (
  id bigint generated always as identity primary key,
  user_id bigint not null,
  username text,
  client_name text,
  phone text,
  product_id bigint references products(id),
  model_title text,
  custom boolean not null default false,
  custom_photo text,
  custom_note text,
  price bigint,
  prepay bigint,
  term_days int,
  status text not null default 'await_payment',
  -- await_price | await_payment | await_receipt | paid | in_work | ready | shipped | done | cancelled | expired
  pay_method text,                         -- click | card
  receipt_sent boolean not null default false,
  region text,                             -- t (Ташкент и область) | o (другой регион)
  address text,
  topic_id bigint,
  card_msg_id bigint,
  assigned_to bigint,
  assigned_name text,
  start_date date,
  ready_date date,
  reminders int not null default 0,
  expires_at timestamptz,
  created_at timestamptz default now(),
  paid_at timestamptz,
  done_at timestamptz
);
create index on orders (user_id);
create index on orders (topic_id);
create index on orders (status);

create table messages (
  id bigint generated always as identity primary key,
  order_id bigint references orders(id) on delete cascade,
  direction text not null,                 -- in | out | note | system
  author text,
  text text,
  file_id text,
  file_kind text,
  created_at timestamptz default now()
);
create index on messages (order_id);

create table ideas (
  id bigint generated always as identity primary key,
  file_id text,
  note text,
  created_by bigint,
  status text not null default 'new',
  created_at timestamptz default now()
);

alter table settings enable row level security;
alter table sessions enable row level security;
alter table products enable row level security;
alter table orders enable row level security;
alter table messages enable row level security;
alter table ideas enable row level security;

-- Атомарное добавление фото в черновик (альбомы приходят параллельно)
create or replace function add_draft_photo(p_group text, p_file text, p_admin bigint)
returns table(id bigint, created boolean)
language plpgsql as $$
#variable_conflict use_column
begin
  if p_group is null then
    return query
      insert into products(photos, created_by) values (array[p_file], p_admin)
      returning products.id, true;
  else
    return query
      insert into products(photos, created_by, media_group_id)
      values (array[p_file], p_admin, p_group)
      on conflict (media_group_id)
      do update set photos = products.photos || excluded.photos
      returning products.id, (products.xmax = 0);
  end if;
end $$;
