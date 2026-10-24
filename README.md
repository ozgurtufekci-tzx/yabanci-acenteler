# Yabancı Acenteler

Domaza için yabancı acente listesi: kart görünümü, durum takibi (sisteme dahil / görüşülüyor / dahil değil), JSON ile toplu yükleme ve kriterli Excel çıktısı.

Canlı adres: https://yabanci-acenteler.netlify.app

## Yapı

| Yol | İçerik |
|-----|--------|
| `public/index.html` | Sayfanın tamamı (tek dosya) |
| `netlify/functions/api.mjs` | `/api/*` uç noktaları: giriş, listeleme, ekleme, güncelleme, silme |
| `netlify/database/migrations/` | Netlify Database tabloları (deploy sırasında otomatik uygulanır) |
| `netlify.toml` | Yayın ayarları |

## Giriş

Panel tek bir şifreyle açılır. Şifre Netlify'da **Project configuration → Environment variables → `PANEL_SIFRESI`** değişkeninde durur. Değiştirmek için değeri güncelleyip **Deploys → Trigger deploy** ile yeniden yayınla; açık oturumlar kapanır.

Aynı IP'den 15 dakikada 8 hatalı denemeden sonra giriş geçici olarak durur.

## Veritabanı

Netlify Database (Postgres). İlk deploy'da otomatik oluşturulur. Tablo değişiklikleri yalnızca `netlify/database/migrations/` altına yeni dosya eklenerek yapılır; uygulanmış bir migration dosyası değiştirilmemeli.

Yedek almak için sayfadaki **Excel'e aktar → JSON yedeği** seçeneği kullanılabilir; bu dosya aynı sayfadan geri yüklenebilir.
