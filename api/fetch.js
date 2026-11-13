
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const { url } = req.body || {};

    if (!url || typeof url !== "string") {
      return res.status(400).json({
        ok: false,
        error: "URL wajib diisi"
      });
    }

    const target = new URL(url);

    if (!["http:", "https:"].includes(target.protocol)) {
      return res.status(400).json({
        ok: false,
        error: "Protokol URL tidak diizinkan"
      });
    }

    const hostname = target.hostname.toLowerCase();

    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "0.0.0.0" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("169.254.") ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)
    ) {
      return res.status(403).json({
        ok: false,
        error: "Alamat jaringan privat tidak diizinkan"
      });
    }

    const response = await fetch(target.href, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": "Mozilla/5.0 RAFZ-Extractor/1.0",
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: `Website merespons HTTP ${response.status}`
      });
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/html")) {
      return res.status(415).json({
        ok: false,
        error: "URL tersebut bukan halaman HTML"
      });
    }

    const html = await response.text();

    if (html.length > 4 * 1024 * 1024) {
      return res.status(413).json({
        ok: false,
        error: "Ukuran HTML terlalu besar"
      });
    }

    return res.status(200).json({
      ok: true,
      url: response.url,
      html,
      contentType
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.name === "TimeoutError"
        ? "Website terlalu lama merespons"
        : "Gagal mengambil website"
    });
  }
}
