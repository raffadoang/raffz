RAFZ WEB EXTRACTOR — VERCEL EDITION

DEPLOY
1. Upload/import folder ini sebagai project ke Vercel (GitHub import atau Vercel CLI).
2. Vercel akan otomatis mendeteksi index.html sebagai static frontend dan api/*.js sebagai Serverless Functions.
3. Deploy dengan Node.js 20+.
4. Buka URL deployment Vercel. Tidak perlu menjalankan server.js atau menyediakan hosting Node.js terpisah.

CARA KERJA
- AMBIL HTML memanggil /api/fetch.
- DOWNLOAD HASIL memanggil /api/extract.
- Jika tidak ada aset eksternal yang berhasil dikumpulkan, respons berupa website.html.
- Jika ada CSS, JavaScript, gambar, font, ikon, media, atau aset eksternal lain yang berhasil dikumpulkan, respons berupa ZIP berisi index.html dan folder assets/.

BATASAN
- Hanya mengambil resource HTTP/HTTPS publik yang dapat diakses.
- Tidak melewati login, CAPTCHA, paywall, proteksi akses, atau kebijakan website.
- Halaman yang dirender oleh JavaScript runtime, API privat, atau memerlukan sesi login dapat tidak tersalin sempurna.
- Batas ukuran dan jumlah aset diterapkan untuk menjaga fungsi tetap aman dan sesuai batas serverless.
- Serverless Vercel memiliki batas durasi, memori, dan ukuran respons sesuai paket dan runtime Vercel.
