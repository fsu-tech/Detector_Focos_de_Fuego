const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, ".env");
const SEEN_PATH = path.join(ROOT, "notified-fires.json");
const EARTHQUAKE_SEEN_PATH = path.join(ROOT, "notified-earthquakes.json");
const LOCATION_PATH = path.join(ROOT, "current-location.json");

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
  earthquakeMinMagnitude: Number(process.env.EARTHQUAKE_MIN_MAGNITUDE || 1.5),
  earthquakeDays: Math.min(10, Math.max(1, Number(process.env.EARTHQUAKE_DAYS || 7))),
  interval: Math.max(1, Number(process.env.CHECK_INTERVAL_MINUTES || 15)),
  port: Number(process.env.PORT || 3000)
};

try {
  const savedLocation = JSON.parse(fs.readFileSync(LOCATION_PATH, "utf8"));
  if (Number.isFinite(savedLocation.lat) && Number.isFinite(savedLocation.lon)) {
    config.lat = savedLocation.lat;
    config.lon = savedLocation.lon;
  }
  if (savedLocation.chatId) config.chatId = String(savedLocation.chatId);
} catch {}

function saveRuntimeState() {
  fs.writeFileSync(LOCATION_PATH, JSON.stringify({
    lat: config.lat, lon: config.lon, chatId: config.chatId,
    updatedAt: new Date().toISOString()
  }, null, 2));
}

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

function destinationPoint(lat, lon, bearing, distance) {
  const rad = degrees => degrees * Math.PI / 180;
  const angularDistance = distance / 6371;
  const lat1 = rad(lat);
  const lon1 = rad(lon);
  const direction = rad(bearing);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angularDistance) +
    Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(direction));
  const lon2 = lon1 + Math.atan2(
    Math.sin(direction) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
  );
  return [lat2 * 180 / Math.PI, lon2 * 180 / Math.PI];
}

function chooseEscapePlan(lat, lon, fires, distance = 30) {
  let best = null;
  for (let bearing = 0; bearing < 360; bearing += 15) {
    const point = destinationPoint(lat, lon, bearing, distance);
    let clearance = Infinity;
    for (let sample = 1; sample <= 10; sample++) {
      const routePoint = destinationPoint(lat, lon, bearing, distance * sample / 10);
      for (const fire of fires) {
        clearance = Math.min(clearance, distanceKm(
          routePoint[0], routePoint[1], Number(fire.latitude), Number(fire.longitude)
        ));
      }
    }
    if (!best || clearance > best.clearance) best = { point, bearing, clearance };
  }
  return best;
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
  saveRuntimeState();
  return config.chatId;
}

async function sendMessage(text) {
  if (!config.chatId) await discoverChatId();
  await telegram("sendMessage", { chat_id: config.chatId, text, disable_web_page_preview: true });
}

async function requestCurrentLocation() {
  if (!config.chatId) await discoverChatId();
  await telegram("sendMessage", {
    chat_id: config.chatId,
    text: "Pulsa el botón para usar la ubicación GPS actual en distancias y rutas.",
    reply_markup: {
      keyboard: [[{ text: "📍 Compartir mi ubicación", request_location: true }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
}

let telegramUpdateOffset = 0;
let pollingTelegram = false;
async function pollTelegramLocations() {
  if (pollingTelegram || !config.token) return;
  pollingTelegram = true;
  try {
    const updates = await telegram("getUpdates", {
      offset: telegramUpdateOffset || undefined,
      limit: 100,
      timeout: 0,
      allowed_updates: ["message", "edited_message"]
    });
    for (const update of updates) {
      telegramUpdateOffset = Math.max(telegramUpdateOffset, update.update_id + 1);
      const message = update.edited_message || update.message;
      if (!message?.chat?.id) continue;
      if (!config.chatId) {
        config.chatId = String(message.chat.id);
        saveRuntimeState();
      }
      if (String(message.chat.id) !== String(config.chatId)) continue;
      if (message.text === "/start") {
        await requestCurrentLocation();
        continue;
      }
      if (!message.location) continue;
      config.lat = Number(message.location.latitude);
      config.lon = Number(message.location.longitude);
      saveRuntimeState();
      await sendMessage(
        "📍 Ubicación actualizada. A partir de ahora calcularé distancias y rutas desde este punto."
      );
      await runInitialCheck();
    }
  } catch (error) {
    console.error("Actualización de ubicación fallida:", error.message);
  } finally {
    pollingTelegram = false;
  }
}

function loadSeen(filePath = SEEN_PATH) {
  try { return new Set(JSON.parse(fs.readFileSync(filePath, "utf8"))); }
  catch { return new Set(); }
}

function loadEarthquakeSeen() {
  try {
    const saved = JSON.parse(fs.readFileSync(EARTHQUAKE_SEEN_PATH, "utf8"));
    return saved?.version === 1 && Array.isArray(saved.ids) ? new Set(saved.ids) : new Set();
  } catch { return new Set(); }
}

function saveEarthquakeSeen(seen) {
  fs.writeFileSync(EARTHQUAKE_SEEN_PATH, JSON.stringify({
    version: 1,
    ids: [...seen].slice(-5000)
  }, null, 2));
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

  const escapePlan = nearby.length ? chooseEscapePlan(config.lat, config.lon, nearby) : null;

  if (notify && fresh.length) {
    const fire = fresh[0];
    const routeUrl = "https://www.google.com/maps/dir/?api=1&origin=" +
      encodeURIComponent(config.lat + "," + config.lon) + "&destination=" +
      encodeURIComponent(escapePlan.point[0].toFixed(6) + "," + escapePlan.point[1].toFixed(6)) +
      "&travelmode=driving";
    await sendMessage(
      "🔥 Alerta FIRMS: " + nearby.length + " foco(s) térmico(s) a menos de " + config.radius + " km de tu ubicación.\n" +
      "Nuevos desde la última comprobación: " + fresh.length + "\n\n" +
      `Nuevo más cercano: ${fire.distance.toFixed(1)} km\nFecha/hora: ${fire.acq_date || "—"} ${fire.acq_time || "—"} UTC\n` +
      `Confianza: ${fire.confidence || "—"}\nFRP: ${fire.frp || "—"} MW\n` +
      "Fuentes: " + fire.sources.join(", ") + "\n" +
      "Foco: https://www.google.com/maps?q=" + fire.latitude + "," + fire.longitude + "\n\n" +
      "⚠️ Ruta orientativa calculada respecto a todos los focos; NO es una evacuación oficial:\n" + routeUrl +
      "\nSigue siempre las indicaciones del 112 y de las autoridades."
    );
    fresh.forEach(fire => seen.add(id(fire)));
    fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen].slice(-5000), null, 2));
  }
  return {
    totalNearby: nearby.length, newFires: fresh.length, fires: nearby,
    location: { lat: config.lat, lon: config.lon }, radius: config.radius,
    checkedAt: new Date().toISOString(), escapePlan
  };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function checkEarthquakes({ notify = false } = {}) {
  const ignUrl = "https://www.ign.es/web/ultimos-terremotos/-/ultimos-terremotos/get10dias";
  const response = await fetch(ignUrl, { headers: { "user-agent": "FIRMS-Watch/1.0" } });
  if (!response.ok) throw new Error("IGN respondió HTTP " + response.status);
  const html = await response.text();
  const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match =>
    match[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim()
  );
  const cutoff = Date.now() - config.earthquakeDays * 24 * 60 * 60 * 1000;
  const parsed = [];
  for (let i = 0; i <= cells.length - 11; i++) {
    if (!/^es\d{4}[a-z]+$/i.test(cells[i])) continue;
    const [day, month, year] = cells[i + 1].split("/");
    const timestamp = Date.parse(`${year}-${month}-${day}T${cells[i + 2]}Z`);
    const latitude = Number(cells[i + 4]);
    const longitude = Number(cells[i + 5]);
    const depth = Number(cells[i + 6]);
    const magnitude = Number(cells[i + 7]);
    if (![timestamp, latitude, longitude, depth, magnitude].every(Number.isFinite)) continue;
    parsed.push({
      id: cells[i],
      latitude,
      longitude,
      depth,
      magnitude,
      place: cells[i + 10] || "Ubicación sin especificar",
      time: new Date(timestamp).toISOString(),
      status: "reviewed",
      tsunami: false,
      url: "https://www.ign.es/web/ultimos-terremotos/-/ultimos-terremotos/getDetails?evid=" + encodeURIComponent(cells[i]),
      distance: distanceKm(config.lat, config.lon, latitude, longitude)
    });
    i += 11;
  }
  const earthquakes = [...new Map(parsed.map(earthquake => [earthquake.id, earthquake])).values()]
    .filter(earthquake => earthquake.magnitude >= config.earthquakeMinMagnitude && Date.parse(earthquake.time) >= cutoff)
    .sort((a, b) => new Date(b.time) - new Date(a.time));
  const nearby = earthquakes
    .filter(earthquake => earthquake.distance <= config.radius)
    .sort((a, b) => a.distance - b.distance);
  const seen = loadEarthquakeSeen();
  const fresh = nearby.filter(earthquake => !seen.has(earthquake.id));

  if (notify && fresh.length) {
    const earthquake = fresh[0];
    const utcTime = new Date(earthquake.time).toISOString().slice(0, 16).replace("T", " ");
    await sendMessage(
      "🌍 Alerta sísmica IGN: " + fresh.length + " terremoto(s) nuevo(s) a menos de " + config.radius + " km de tu ubicación.\n\n" +
      `Más cercano: magnitud ${earthquake.magnitude.toFixed(1)} · ${earthquake.place}\n` +
      `Distancia: ${earthquake.distance.toFixed(1)} km\n` +
      `Profundidad: ${earthquake.depth.toFixed(1)} km\n` +
      `Fecha/hora: ${utcTime} UTC\n` +
      "Epicentro: https://www.google.com/maps?q=" + earthquake.latitude + "," + earthquake.longitude + "\n" +
      "Ficha IGN: " + earthquake.url + "\n\n" +
      "Información automática. Sigue las indicaciones del 112 y de las autoridades si el terremoto se ha sentido."
    );
    fresh.forEach(earthquake => seen.add(earthquake.id));
    saveEarthquakeSeen(seen);
  }

  return {
    earthquakes,
    total: earthquakes.length,
    totalNearby: nearby.length,
    newEarthquakes: fresh.length,
    location: { lat: config.lat, lon: config.lon },
    radius: config.radius,
    coverage: "España",
    source: "IGN",
    minMagnitude: config.earthquakeMinMagnitude,
    days: config.earthquakeDays,
    checkedAt: new Date().toISOString()
  };
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
      await sendMessage(`✅ Prueba correcta. Alertas activas para tu ubicación en un radio de ${config.radius} km.`);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/api/fires/check") {
      return json(res, 200, { ok: true, ...(await checkFires({ notify: false })) });
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/earthquakes") {
      return json(res, 200, { ok: true, ...(await checkEarthquakes()) });
    }
    if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return fs.createReadStream(path.join(ROOT, "dashboard.html")).pipe(res);
    }
    if (req.method === "GET" && req.url === "/mapa_focos_firms.html") {
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
let initialCheckStarted = false;
async function scheduledCheck() {
  if (checking) return;
  checking = true;
  try { console.log("Comprobación FIRMS:", await checkFires()); }
  catch (error) { console.error("Comprobación FIRMS fallida:", error.message); }
  try { console.log("Comprobación IGN:", await checkEarthquakes({ notify: true })); }
  catch (error) { console.error("Comprobación IGN fallida:", error.message); }
  finally { checking = false; }
}

async function runInitialCheck() {
  if (initialCheckStarted) return;
  initialCheckStarted = true;
  await scheduledCheck();
}

server.listen(config.port, () => {
  console.log(`Servidor disponible en http://localhost:${config.port}`);
  console.log("Ubicación activa: " + config.lat + ", " + config.lon + "; radio " + config.radius + " km, cada " + config.interval + " min");
  setTimeout(() => requestCurrentLocation().catch(error => console.error(error.message)), 1000);
  setTimeout(pollTelegramLocations, 5000);
  setInterval(pollTelegramLocations, 10000);
  setTimeout(runInitialCheck, 60000);
  setInterval(scheduledCheck, config.interval * 60 * 1000);
});
