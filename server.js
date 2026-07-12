const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, ".env");
const SEEN_PATH = path.join(ROOT, "notified-fires.json");

if (fs.existsSync(ENV_PATH)) {
  for (const raw of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const config = {
  token: process.env.TELEGRAM_BOT_TOKEN || "",
  chatId: process.env.TELEGRAM_CHAT_ID || "",
  firmsKey: process.env.FIRMS_MAP_KEY || "",
  lat: Number(process.env.ALERT_LAT || 37.2194),
  lon: Number(process.env.ALERT_LON || -3.78306),
  radius: Number(process.env.ALERT_RADIUS_KM || 500),
  interval: Math.max(1, Number(process.env.CHECK_INTERVAL_MINUTES || 15)),
  port: Number(process.env.PORT || 3000)
};

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(x => x.trim());
  return lines.slice(1).map(line => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((header, i) => [header, values[i]?.trim() || ""]));
  });
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = degrees => degrees * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function telegram(method, body) {
  if (!config.token) throw new Error("Falta TELEGRAM_BOT_TOKEN en .env");
  const response = await fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || "Error de Telegram");
  return data.result;
}

async function discoverChatId() {
  const updates = await telegram("getUpdates", { limit: 100, timeout: 0 });
  const update = [...updates].reverse().find(x => x.message?.chat?.id);
  if (!update) throw new Error("No encuentro /start; envía otro mensaje al bot");
  config.chatId = String(update.message.chat.id);
  return config.chatId;
}

async function sendMessage(text) {
  if (!config.chatId) await discoverChatId();
  await telegram("sendMessage", { chat_id: config.chatId, text, disable_web_page_preview: true });
}

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_PATH, "utf8"))); }
  catch { return new Set(); }
}

async function checkFires({ notify = true } = {}) {
  if (!/^[a-fA-F0-9]{32}$/.test(config.firmsKey)) throw new Error("Falta FIRMS_MAP_KEY válida en .env");
  const area = "-10,35.5,4.8,44.2";
  const sources = ["VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT"];
  const results = await Promise.all(sources.map(async source => {
    const url = "https://firms2.modaps.eosdis.nasa.gov/api/area/csv/" +
      encodeURIComponent(config.firmsKey) + "/" + source + "/" + area + "/1";
    const response = await fetch(url);
    if (!response.ok) throw new Error(source + ": NASA FIRMS respondió HTTP " + response.status);
    const text = await response.text();
    if (/invalid map.?key/i.test(text)) throw new Error("NASA FIRMS rechazó la MAP_KEY");
    return parseCSV(text).map(fire => ({ ...fire, source }));
  }));

  const acquisitionTime = fire => {
    const time = String(fire.acq_time || "").padStart(4, "0");
    return Date.parse(fire.acq_date + "T" + time.slice(0, 2) + ":" + time.slice(2, 4) + ":00Z");
  };
  const deduplicated = [];
  for (const fire of results.flat()) {
    const duplicate = deduplicated.find(saved =>
      distanceKm(Number(saved.latitude), Number(saved.longitude), Number(fire.latitude), Number(fire.longitude)) <= 2 &&
      Math.abs(acquisitionTime(saved) - acquisitionTime(fire)) <= 60 * 60 * 1000
    );
    if (duplicate) {
      const satellites = new Set([...(duplicate.sources || [duplicate.source]), fire.source]);
      duplicate.sources = [...satellites];
      if (Number(fire.frp || 0) > Number(duplicate.frp || 0)) duplicate.frp = fire.frp;
    } else {
      deduplicated.push({ ...fire, sources: [fire.source] });
    }
  }

  const nearby = deduplicated.map(fire => ({
    ...fire, distance: distanceKm(config.lat, config.lon, Number(fire.latitude), Number(fire.longitude))
  })).filter(fire => Number.isFinite(fire.distance) && fire.distance <= config.radius)
    .sort((a, b) => a.distance - b.distance);

  const seen = loadSeen();
  const id = fire => [fire.latitude, fire.longitude, fire.acq_date, fire.acq_time, fire.satellite].join("|");
  const fresh = nearby.filter(fire => !seen.has(id(fire)));
  if (notify) {
    fresh.forEach(fire => seen.add(id(fire)));
    if (fresh.length) fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen].slice(-5000), null, 2));
  }

  if (notify && nearby.length) {
    const fire = nearby[0];
    await sendMessage(
      "🔥 Alerta FIRMS: " + nearby.length + " foco(s) térmico(s) a menos de " + config.radius + " km de Fuente Vaqueros.\n" +
      "Nuevos desde la última comprobación: " + fresh.length + "\n\n" +
      `Más cercano: ${fire.distance.toFixed(1)} km\nFecha/hora: ${fire.acq_date || "—"} ${fire.acq_time || "—"} UTC\n` +
      `Confianza: ${fire.confidence || "—"}\nFRP: ${fire.frp || "—"} MW\n` +
      "Fuentes: " + fire.sources.join(", ") + "\n" +
      `https://www.google.com/maps?q=${fire.latitude},${fire.longitude}`
    );
  }
  return { totalNearby: nearby.length, newFires: fresh.length, fires: nearby };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const allowedOrigins = new Set(["http://127.0.0.1:5500", "http://localhost:5500"]);
    const origin = req.headers.origin;
    if (allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const requestUrl = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    if (req.method === "GET" && requestUrl.pathname === "/api/fires/history") {
      const allowedSources = new Set([
        "VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT"
      ]);
      const source = requestUrl.searchParams.get("source") || "VIIRS_SNPP_NRT";
      const date = requestUrl.searchParams.get("date") || "";
      if (!allowedSources.has(source)) throw new Error("Fuente FIRMS no válida");
      if (date && !/^d{4}-d{2}-d{2}$/.test(date)) throw new Error("Fecha no válida");
      if (!/^[a-fA-F0-9]{32}$/.test(config.firmsKey)) throw new Error("Falta FIRMS_MAP_KEY válida en .env");
      const area = "-10,35.5,4.8,44.2";
      const dateSegment = date ? "/" + date : "";
      const firmsUrl = "https://firms2.modaps.eosdis.nasa.gov/api/area/csv/" +
        encodeURIComponent(config.firmsKey) + "/" + source + "/" + area + "/1" + dateSegment;
      const firmsResponse = await fetch(firmsUrl);
      if (!firmsResponse.ok) throw new Error("NASA FIRMS respondió HTTP " + firmsResponse.status);
      const text = await firmsResponse.text();
      if (/invalid map.?key/i.test(text)) throw new Error("NASA FIRMS rechazó la MAP_KEY");
      return json(res, 200, { ok: true, fires: parseCSV(text) });
    }
    if (req.method === "POST" && req.url === "/api/telegram/setup") {
      await discoverChatId();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/api/telegram/test") {
      await sendMessage(`✅ Prueba correcta. Alertas activas para Fuente Vaqueros en un radio de ${config.radius} km.`);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/api/fires/check") {
      return json(res, 200, { ok: true, ...(await checkFires({ notify: false })) });
    }
    if (req.method === "GET" && (req.url === "/" || req.url === "/mapa_focos_firms.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return fs.createReadStream(path.join(ROOT, "mapa_focos_firms.html")).pipe(res);
    }
    json(res, 404, { ok: false, error: "No encontrado" });
  } catch (error) {
    console.error(error.message);
    json(res, 500, { ok: false, error: error.message });
  }
});

let checking = false;
async function scheduledCheck() {
  if (checking) return;
  checking = true;
  try { console.log("Comprobación FIRMS:", await checkFires()); }
  catch (error) { console.error("Comprobación FIRMS fallida:", error.message); }
  finally { checking = false; }
}

server.listen(config.port, () => {
  console.log(`Servidor disponible en http://localhost:${config.port}`);
  console.log(`Fuente Vaqueros: radio ${config.radius} km, cada ${config.interval} min`);
  setTimeout(scheduledCheck, 3000);
  setInterval(scheduledCheck, config.interval * 60 * 1000);
});
