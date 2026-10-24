-- Yabancı Acenteler: ana tablo ve giriş denemeleri

CREATE TABLE IF NOT EXISTS acenteler (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad            text NOT NULL,
  unvan         text NOT NULL DEFAULT '',
  kategori      text NOT NULL DEFAULT '',
  lisans_no     text NOT NULL DEFAULT '',
  yetkili       text NOT NULL DEFAULT '',
  telefon       text NOT NULL DEFAULT '',
  gsm           text NOT NULL DEFAULT '',
  email         text NOT NULL DEFAULT '',
  web           text NOT NULL DEFAULT '',
  ulke          text NOT NULL DEFAULT '',
  sehir         text NOT NULL DEFAULT '',
  adres         text NOT NULL DEFAULT '',
  notlar        text NOT NULL DEFAULT '',
  durum         text NOT NULL DEFAULT 'aday' CHECK (durum IN ('aday', 'gorusme', 'dahil')),
  dahil_tarihi  date,
  kaynak        text NOT NULL DEFAULT 'manuel',
  dosya         text NOT NULL DEFAULT '',
  ekstra        jsonb NOT NULL DEFAULT '{}'::jsonb,
  eklenme       timestamptz NOT NULL DEFAULT now(),
  guncelleme    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS acenteler_eklenme_idx ON acenteler (eklenme, id);
CREATE INDEX IF NOT EXISTS acenteler_durum_idx ON acenteler (durum);
CREATE INDEX IF NOT EXISTS acenteler_ulke_idx ON acenteler (ulke);

CREATE TABLE IF NOT EXISTS giris_denemeleri (
  id     bigserial PRIMARY KEY,
  ip     text NOT NULL,
  zaman  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS giris_denemeleri_ip_idx ON giris_denemeleri (ip, zaman);
