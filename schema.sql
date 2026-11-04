create extension if not exists pgcrypto;

create type public.user_role as enum ('admin','collaborator','buyer');
create type public.comic_status as enum ('disponivel','reservado','vendido','inativo');
create type public.comic_condition as enum ('Excelente estado','Estado de colecionador','Bom, com marcas de uso','Ruim, apresenta rasgos','Péssimo, apresenta folhas faltando');
create type public.order_status as enum ('pending','approved','rejected','cancelled','expired');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.user_role not null default 'buyer',
  full_name text not null,
  nickname text,
  whatsapp text,
  avatar_url text,
  bio text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint collaborator_nickname check (role not in ('admin','collaborator') or nickname is not null)
);

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  character_category text,
  expected_issues int check (expected_issues is null or expected_issues > 0),
  is_complete boolean not null default false,
  lot_discount_percent numeric(5,2) not null default 0 check (lot_discount_percent between 0 and 100),
  created_at timestamptz not null default now()
);

create table public.comics (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete restrict,
  collection_id uuid references public.collections(id) on delete set null,
  title text not null,
  issue_number int,
  publish_year int check (publish_year between 1900 and 2100),
  character_category text,
  condition public.comic_condition not null,
  suggested_price numeric(12,2) not null check (suggested_price >= 0),
  sale_price numeric(12,2) not null check (sale_price >= 0),
  max_discount_percent numeric(5,2) not null default 0 check (max_discount_percent between 0 and 100),
  description text not null default '',
  internal_notes text,
  image_url text not null,
  is_rare boolean not null default false,
  status public.comic_status not null default 'disponivel',
  reserved_until timestamptz,
  reservation_token uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index comics_filter_idx on public.comics(status, publish_year, character_category);
create index comics_owner_idx on public.comics(owner_id);
create index comics_reservation_idx on public.comics(status, reserved_until);

create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text unique not null check (code = upper(code)),
  discount_percent numeric(5,2) not null check (discount_percent > 0 and discount_percent <= 100),
  active boolean not null default true,
  starts_at timestamptz,
  expires_at timestamptz,
  max_uses int check (max_uses is null or max_uses > 0),
  use_count int not null default 0,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid references public.profiles(id),
  buyer_name text not null,
  buyer_email text not null,
  buyer_whatsapp text not null,
  reservation_token uuid unique not null,
  coupon_code text,
  subtotal numeric(12,2) not null,
  discount numeric(12,2) not null default 0,
  total numeric(12,2) not null,
  status public.order_status not null default 'pending',
  mp_preference_id text,
  mp_payment_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  comic_id uuid not null references public.comics(id),
  owner_id uuid not null references public.profiles(id),
  title text not null,
  unit_price numeric(12,2) not null,
  final_price numeric(12,2) not null,
  unique(order_id, comic_id)
);

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role='admin' and active);
$$;

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger comics_updated before update on public.comics for each row execute function public.set_updated_at();
create trigger orders_updated before update on public.orders for each row execute function public.set_updated_at();

create or replace function public.release_expired_reservations() returns int language plpgsql security definer set search_path=public as $$
declare affected int;
begin
  update public.comics set status='disponivel', reserved_until=null, reservation_token=null
  where status='reservado' and reserved_until < now();
  get diagnostics affected = row_count;
  update public.orders set status='expired' where status='pending' and reservation_token not in
    (select reservation_token from public.comics where status='reservado' and reservation_token is not null);
  return affected;
end $$;

create or replace function public.increment_coupon_use(p_code text) returns void language sql security definer set search_path=public as $$
  update public.coupons set use_count=use_count+1 where code=p_code and active;
$$;

create or replace function public.refresh_collection_complete(p_collection uuid) returns void language plpgsql security definer set search_path=public as $$
declare expected int; actual int;
begin
  select expected_issues into expected from public.collections where id=p_collection;
  if expected is not null then
    select count(distinct issue_number) into actual from public.comics where collection_id=p_collection and status <> 'inativo';
    update public.collections set is_complete=(actual >= expected) where id=p_collection;
  end if;
end $$;

alter table public.profiles enable row level security;
alter table public.collections enable row level security;
alter table public.comics enable row level security;
alter table public.coupons enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

create policy "own profile read" on public.profiles for select to authenticated using (id=auth.uid() or public.is_admin());
create policy "own profile" on public.profiles for update to authenticated using (id=auth.uid()) with check (id=auth.uid());
create policy "admin profiles" on public.profiles for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "public collections" on public.collections for select using (true);
create policy "owners collections" on public.collections for all to authenticated using (owner_id=auth.uid() or public.is_admin()) with check (owner_id=auth.uid() or public.is_admin());
create policy "public available comics" on public.comics for select using (status in ('disponivel','reservado'));
create policy "owners comics" on public.comics for all to authenticated using (owner_id=auth.uid() or public.is_admin()) with check (owner_id=auth.uid() or public.is_admin());
create policy "buyers own orders" on public.orders for select to authenticated using (buyer_id=auth.uid() or public.is_admin());
create policy "buyers own items" on public.order_items for select to authenticated using (exists(select 1 from public.orders o where o.id=order_id and (o.buyer_id=auth.uid() or public.is_admin())));
create policy "admin coupons" on public.coupons for all to authenticated using (public.is_admin()) with check (public.is_admin());

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('comics','comics',true,5242880,array['image/webp']) on conflict (id) do nothing;
create policy "public comic images" on storage.objects for select using (bucket_id='comics');
create policy "authenticated upload own folder" on storage.objects for insert to authenticated with check (bucket_id='comics' and (storage.foldername(name))[1]=auth.uid()::text);
create policy "owner image update" on storage.objects for update to authenticated using (bucket_id='comics' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));
create policy "owner image delete" on storage.objects for delete to authenticated using (bucket_id='comics' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));

-- Depois de criar o primeiro usuário no Auth, promova-o uma única vez:
-- insert into public.profiles(id,role,full_name,nickname) values ('UUID_DO_AUTH','admin','Manoel','Manu');
