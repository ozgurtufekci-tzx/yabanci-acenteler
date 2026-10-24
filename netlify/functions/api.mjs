// Yabancı Acenteler · sunucu API'si (Netlify Functions v2 + Netlify Database)
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { getDatabase } from '@netlify/database'

export const config = { path: '/api/*' }

const COOKIE = 'ya_oturum'
const SESSION_SECONDS = 30 * 24 * 60 * 60
const MAX_BATCH = 1000
const PAGE_MAX = 2000
const FAIL_WINDOW_MIN = 15
const FAIL_LIMIT = 8

const TEXT_FIELDS = ['ad', 'unvan', 'kategori', 'lisans_no', 'yetkili', 'telefon', 'gsm', 'email', 'web', 'ulke', 'sehir', 'adres', 'notlar', 'kaynak', 'dosya']
const DURUMLAR = new Set(['aday', 'gorusme', 'dahil'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const COLS = `id, ad, unvan, kategori, lisans_no, yetkili, telefon, gsm, email, web, ulke, sehir, adres, notlar, durum,
  to_char(dahil_tarihi, 'YYYY-MM-DD') AS dahil_tarihi, kaynak, dosya, ekstra, eklenme, guncelleme`

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/* ---------- helpers ---------- */
function env(name) {
  try {
    const v = globalThis.Netlify?.env?.get(name)
    if (v) return v
  } catch {}
  return process.env[name] || ''
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  })
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest()
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sessionKey(pw) {
  return sha256('yabanci-acenteler/oturum/v1/' + pw)
}

function makeToken(pw) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS
  const sig = b64url(createHmac('sha256', sessionKey(pw)).update(String(exp)).digest())
  return exp + '.' + sig
}

function readCookie(req, name) {
  const raw = req.headers.get('cookie') || ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return ''
}

function isAuthed(req) {
  const pw = env('PANEL_SIFRESI')
  if (!pw) return false
  const tok = readCookie(req, COOKIE)
  const [expStr, sig] = tok.split('.')
  const exp = Number(expStr)
  if (!sig || !Number.isFinite(exp) || exp < Date.now() / 1000) return false
  const expected = b64url(createHmac('sha256', sessionKey(pw)).update(String(exp)).digest())
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function cookieHeader(value, maxAge) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
}

async function readJson(req) {
  try {
    return await req.json()
  } catch {
    throw new HttpError(400, 'İstek gövdesi geçerli JSON değil.')
  }
}

function cleanText(v) {
  return String(v == null ? '' : v).slice(0, 4000)
}

function cleanEkstra(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out = {}
  let n = 0
  for (const [k, val] of Object.entries(v)) {
    if (n >= 100) break
    const key = String(k).slice(0, 60).trim()
    if (!key || val == null || val === '') continue
    out[key] = typeof val === 'object' ? JSON.stringify(val).slice(0, 4000) : String(val).slice(0, 4000)
    n++
  }
  return out
}

// Turns an incoming row into a whitelisted object. For inserts every field is filled;
// for updates only the fields that were sent are kept.
function cleanRow(row, mode) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new HttpError(400, 'Her kayıt bir nesne olmalı.')
  const out = {}
  if (row.id != null && row.id !== '') {
    if (!UUID_RE.test(String(row.id))) throw new HttpError(400, 'Geçersiz kayıt kimliği.')
    out.id = String(row.id)
  }
  if (mode === 'update' && !out.id) throw new HttpError(400, 'Güncellenecek kaydın kimliği eksik.')
  for (const f of TEXT_FIELDS) {
    if (f in row) out[f] = cleanText(row[f]).trim()
    else if (mode === 'insert') out[f] = f === 'kaynak' ? 'manuel' : ''
  }
  if ('ad' in out && !out.ad) throw new HttpError(400, 'Firma adı boş olamaz.')
  if (mode === 'insert' && !out.ad) throw new HttpError(400, 'Firma adı boş olamaz.')
  if ('durum' in row || mode === 'insert') {
    const d = String(row.durum || 'aday')
    if (!DURUMLAR.has(d)) throw new HttpError(400, 'Geçersiz durum: ' + d)
    out.durum = d
  }
  if ('dahil_tarihi' in row || mode === 'insert') {
    const t = row.dahil_tarihi ? String(row.dahil_tarihi).slice(0, 10) : ''
    if (t && !DATE_RE.test(t)) throw new HttpError(400, 'Geçersiz tarih: ' + t)
    out.dahil_tarihi = t || null
  }
  if ('ekstra' in row || mode === 'insert') out.ekstra = cleanEkstra(row.ekstra)
  if (mode === 'insert') {
    for (const f of ['eklenme', 'guncelleme']) {
      const s = row[f] ? String(row[f]).slice(0, 40) : ''
      out[f] = s && !isNaN(new Date(s)) ? s : null
    }
  }
  return out
}

function cleanBatch(body, mode) {
  const rows = body && body.rows
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'Gönderilecek kayıt yok.')
  if (rows.length > MAX_BATCH) throw new HttpError(413, `Tek seferde en fazla ${MAX_BATCH} kayıt gönderilebilir.`)
  return rows.map((r) => cleanRow(r, mode))
}

/* ---------- SQL ---------- */
const textSel = TEXT_FIELDS.map((f) => `coalesce(r->>'${f}', '${f === 'kaynak' ? 'manuel' : ''}')`).join(',\n    ')

const INSERT_SQL = `
  INSERT INTO acenteler (id, ${TEXT_FIELDS.join(', ')}, durum, dahil_tarihi, ekstra, eklenme, guncelleme)
  SELECT
    coalesce((r->>'id')::uuid, gen_random_uuid()),
    ${textSel},
    coalesce(r->>'durum', 'aday'),
    (r->>'dahil_tarihi')::date,
    coalesce(r->'ekstra', '{}'::jsonb),
    coalesce((r->>'eklenme')::timestamptz, now()),
    coalesce((r->>'guncelleme')::timestamptz, now())
  FROM jsonb_array_elements($1::jsonb) AS x(r)
  ON CONFLICT (id) DO NOTHING
  RETURNING ${COLS}`

const updSet = TEXT_FIELDS.map((f) => `${f} = CASE WHEN x.r ? '${f}' THEN coalesce(x.r->>'${f}', '') ELSE a.${f} END`).join(',\n    ')

const UPDATE_SQL = `
  UPDATE acenteler AS a SET
    ${updSet},
    durum = CASE WHEN x.r ? 'durum' THEN x.r->>'durum' ELSE a.durum END,
    dahil_tarihi = CASE WHEN x.r ? 'dahil_tarihi' THEN (x.r->>'dahil_tarihi')::date ELSE a.dahil_tarihi END,
    ekstra = CASE WHEN x.r ? 'ekstra' THEN coalesce(x.r->'ekstra', '{}'::jsonb) ELSE a.ekstra END,
    guncelleme = now()
  FROM jsonb_array_elements($1::jsonb) AS x(r)
  WHERE a.id = (x.r->>'id')::uuid
  RETURNING ${COLS}`

/* ---------- handlers ---------- */
async function login(req, context, db) {
  const pw = env('PANEL_SIFRESI')
  if (!pw) throw new HttpError(503, 'Panel şifresi henüz tanımlanmamış. Netlify ortam değişkenlerine PANEL_SIFRESI eklenmeli.')
  const ip = String(context?.ip || req.headers.get('x-nf-client-connection-ip') || 'bilinmiyor').slice(0, 64)

  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM giris_denemeleri WHERE ip = $1 AND zaman > now() - make_interval(mins => $2)`,
    [ip, FAIL_WINDOW_MIN],
  )
  if (rows[0].n >= FAIL_LIMIT) throw new HttpError(429, `Çok fazla hatalı deneme. ${FAIL_WINDOW_MIN} dakika sonra yeniden dene.`)

  const body = await readJson(req)
  const given = String((body && body.sifre) || '')
  const ok = given.length > 0 && timingSafeEqual(sha256(given), sha256(pw))
  if (!ok) {
    await db.query(`INSERT INTO giris_denemeleri (ip) VALUES ($1)`, [ip])
    await db.query(`DELETE FROM giris_denemeleri WHERE zaman < now() - interval '1 day'`)
    await sleep(700)
    throw new HttpError(401, 'Şifre hatalı.')
  }
  await db.query(`DELETE FROM giris_denemeleri WHERE ip = $1`, [ip])
  return json({ giris: true }, 200, { 'set-cookie': cookieHeader(makeToken(pw), SESSION_SECONDS) })
}

async function list(url, db) {
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0)
  const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(url.searchParams.get('limit') || String(PAGE_MAX), 10) || PAGE_MAX))
  const { rows } = await db.query(`SELECT ${COLS} FROM acenteler ORDER BY eklenme, id LIMIT $1 OFFSET $2`, [limit + 1, offset])
  const more = rows.length > limit
  return json({ rows: more ? rows.slice(0, limit) : rows, next: more ? offset + limit : null })
}

async function insert(req, db) {
  const rows = cleanBatch(await readJson(req), 'insert')
  const res = await db.query(INSERT_SQL, [JSON.stringify(rows)])
  return json({ rows: res.rows }, 201)
}

async function update(req, db) {
  const rows = cleanBatch(await readJson(req), 'update')
  const res = await db.query(UPDATE_SQL, [JSON.stringify(rows)])
  return json({ rows: res.rows })
}

async function remove(req, db) {
  const body = await readJson(req)
  const ids = Array.isArray(body && body.ids) ? body.ids.map(String) : []
  if (!ids.length) throw new HttpError(400, 'Silinecek kayıt yok.')
  if (ids.length > MAX_BATCH) throw new HttpError(413, `Tek seferde en fazla ${MAX_BATCH} kayıt silinebilir.`)
  if (!ids.every((id) => UUID_RE.test(id))) throw new HttpError(400, 'Geçersiz kayıt kimliği.')
  const res = await db.query(`DELETE FROM acenteler WHERE id = ANY($1::uuid[]) RETURNING id`, [ids])
  return json({ ids: res.rows.map((r) => r.id) })
}

function dbErrorMessage(e) {
  const code = e && e.code
  if (code === '42P01') return [500, 'Veritabanı tablosu bulunamadı. Migration henüz uygulanmamış olabilir; Netlify deploy kaydını kontrol et.']
  if (code === '23514' || code === '22P02' || code === '22007' || code === '22008') return [400, 'Geçersiz veri: ' + e.message]
  if (e && e.name === 'MissingDatabaseConnectionError') return [503, 'Veritabanı bu siteye bağlı değil. Netlify\'da Data & Storage > Database bölümünü kontrol et.']
  return [500, 'Sunucu hatası: ' + ((e && e.message) || 'bilinmeyen')]
}

export default async (req, context) => {
  const url = new URL(req.url)
  const path = url.pathname.replace(/\/+$/, '')
  const method = req.method.toUpperCase()

  if (method !== 'GET') {
    const origin = req.headers.get('origin')
    if (origin) {
      try {
        if (new URL(origin).host !== url.host) return json({ error: 'İzin verilmeyen kaynak.' }, 403)
      } catch {
        return json({ error: 'İzin verilmeyen kaynak.' }, 403)
      }
    }
  }

  if (path === '/api/oturum' && method === 'GET') {
    return json({ giris: isAuthed(req), hazir: !!env('PANEL_SIFRESI') })
  }
  if (path === '/api/cikis' && method === 'POST') {
    return json({ giris: false }, 200, { 'set-cookie': cookieHeader('', 0) })
  }

  let pool = null
  try {
    if (path === '/api/giris' && method === 'POST') {
      pool = getDatabase().pool
      return await login(req, context, pool)
    }
    if (path === '/api/acenteler') {
      if (!isAuthed(req)) return json({ error: 'Oturum açık değil.' }, 401)
      pool = getDatabase().pool
      if (method === 'GET') return await list(url, pool)
      if (method === 'POST') return await insert(req, pool)
      if (method === 'PATCH') return await update(req, pool)
      if (method === 'DELETE') return await remove(req, pool)
      return json({ error: 'Desteklenmeyen işlem.' }, 405)
    }
    return json({ error: 'Bulunamadı.' }, 404)
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status)
    const [status, message] = dbErrorMessage(e)
    console.error('[api]', path, method, e)
    return json({ error: message }, status)
  } finally {
    if (pool) {
      try {
        await pool.end()
      } catch {}
    }
  }
}
