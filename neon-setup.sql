-- Run this entire script in your Neon SQL Editor to set up the database

CREATE TABLE IF NOT EXISTS "stores" (
  "code" text PRIMARY KEY,
  "name" text NOT NULL,
  "region" text NOT NULL DEFAULT 'WR',
  "emails" text[] NOT NULL DEFAULT '{}',
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "app_settings" (
  "key" text PRIMARY KEY,
  "value" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "expiry_scans" (
  "id" serial PRIMARY KEY,
  "session_id" text NOT NULL,
  "pd_user_name" text NOT NULL,
  "store_location" text NOT NULL,
  "barcode" text NOT NULL,
  "item_number" text,
  "description" text,
  "qty" double precision NOT NULL,
  "rrp" double precision,
  "special_price" double precision,
  "system_soh" double precision,
  "wrong_rrp" boolean NOT NULL DEFAULT false,
  "missing_special_ticket" boolean NOT NULL DEFAULT false,
  "not_on_display" boolean NOT NULL DEFAULT false,
  "bulk_pull_qty" double precision,
  "expiry_date" date NOT NULL,
  "status" text NOT NULL,
  "days_left" integer NOT NULL,
  "scan_date" date NOT NULL,
  "action_required" text,
  "remarks" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Seed all stores
INSERT INTO "stores" ("code", "name", "region", "emails") VALUES
  ('S0001', 'Newworld Ba1',        'WR', ARRAY['nwlba1@newworld.com.fj','mgr_ba1@newworld.com.fj']),
  ('S0003', 'Newworld Ba3',        'WR', ARRAY['nwlba3@newworld.com.fj']),
  ('S0005', 'Newworld Adams',      'WR', ARRAY['nwlada@newworld.com.fj']),
  ('S0006', 'Newworld Namaka',     'WR', ARRAY['nwlnad@newworld.com.fj']),
  ('S0010', 'Newworld Nadi Town',  'WR', ARRAY['nwlnts@newworld.com.fj']),
  ('S0011', 'IGA Super',           'WR', ARRAY['igasup@newworld.com.fj']),
  ('S0013', 'Newworld Rakiraki',   'WR', ARRAY['nwlrak@newworld.com.fj']),
  ('S0025', 'Newworld Tavua',      'WR', ARRAY['nwltav@newworld.com.fj']),
  ('S0018', 'IGA Lautoka',         'WR', ARRAY['igaltk@newworld.com.fj']),
  ('S0035', 'IGA Waiyavi',         'WR', ARRAY['igawaiyavi@newworld.com.fj']),
  ('S0036', 'IGA Nadi Plaza',      'WR', ARRAY['iganad@newworld.com.fj']),
  ('B0004', 'Lautoka Warehouse',   'WR', ARRAY[]::text[]),
  ('B0008', 'Nwl CDC',             'WR', ARRAY[]::text[]),
  ('B0002', 'Ghimly Warehouse',    'WR', ARRAY[]::text[]),
  ('B0001', 'Ba Warehouse',        'WR', ARRAY[]::text[]),
  ('S0019', 'IGA Nakasi',          'CR', ARRAY['iganak@newworld.com.fj']),
  ('S0020', 'Newworld Narere',     'CR', ARRAY['nwlnar@newworld.com.fj']),
  ('S0026', 'Newworld VitiPlaza',  'CR', ARRAY['nwlvit@newworld.com.fj']),
  ('S0021', 'Newworld Nausori',    'CR', ARRAY['nwlnau@newworld.com.fj']),
  ('S0029', 'IGA Damodar',         'CR', ARRAY['igadcc@newworld.com.fj']),
  ('S0033', 'IGA Greig St',        'CR', ARRAY['igagst@newworld.com.fj']),
  ('S0032', 'Central Bakery',      'CR', ARRAY[]::text[]),
  ('B0003', 'Vatuwaqa Warehouse',  'CR', ARRAY[]::text[]),
  ('S0014', 'Newworld Labasa',     'NR', ARRAY['nwllab@newworld.com.fj']),
  ('S0016', 'IGA Savusavu',        'NR', ARRAY['igasavusavu@newworld.com.fj'])
ON CONFLICT ("code") DO NOTHING;
