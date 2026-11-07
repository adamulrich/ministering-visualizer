const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { MongoClient } = require("mongodb");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const root = __dirname;
const port = Number(process.env.PORT || 8081);
const staticDir = path.join(root, "static");
const vendorDir = path.join(root, "node_modules");
const geocodeMemory = new Map();
let mongoClientPromise = null;
let mongoCollectionPromise = null;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function safePath(base, relativePath) {
  const cleanRelative = String(relativePath || "").replace(/^[/\\]+/, "");
  const target = path.resolve(base, cleanRelative);
  const baseResolved = path.resolve(base);
  if (target !== baseResolved && !target.startsWith(baseResolved + path.sep)) return null;
  return target;
}

function serveFile(res, filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(filePath).pipe(res);
}

const aptPattern = /,?\s*(Apt\.?|Unit|Ste\.?|Suite|Trlr|Trailer|Rm\.?|#)\s*\S+/ig;
const zip4Pattern = /(\d{5})-\d{4}\b/g;

function geocodeKey(address) {
  return String(address || "")
    .replace(aptPattern, "")
    .replace(zip4Pattern, "$1")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function mongoCollection() {
  if (!process.env.MONGO_URI) return null;
  if (!mongoCollectionPromise) {
    mongoCollectionPromise = (async () => {
      try {
        if (!mongoClientPromise) {
          const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
          mongoClientPromise = client.connect();
        }
        const client = await mongoClientPromise;
        const collection = client.db("geo_units").collection("geocode_cache");
        await collection.createIndex({ key: 1 }, { unique: true });
        console.log("[geocode] MongoDB cache connected");
        return collection;
      } catch (error) {
        console.warn(`[geocode] MongoDB cache unavailable: ${error.message}`);
        mongoCollectionPromise = Promise.resolve(null);
        return null;
      }
    })();
  }
  return mongoCollectionPromise;
}

async function loadCachedCoordinates(keys) {
  const collection = await mongoCollection();
  if (!collection || !keys.length) return;
  try {
    const docs = await collection.find({ key: { $in: keys } }, { projection: { _id: 0, key: 1, coords: 1 } }).toArray();
    for (const doc of docs) {
      if (Array.isArray(doc.coords) && doc.coords.length === 2) geocodeMemory.set(doc.key, doc.coords);
    }
    console.log(`[geocode] MongoDB cache hit ${docs.length}/${keys.length}`);
  } catch (error) {
    console.warn(`[geocode] MongoDB lookup failed: ${error.message}`);
  }
}

async function persistCoordinates(key, coords) {
  const collection = await mongoCollection();
  if (!collection) return;
  try {
    await collection.updateOne({ key }, { $set: { coords } }, { upsert: true });
  } catch (error) {
    console.warn(`[geocode] MongoDB persist failed: ${error.message}`);
  }
}

async function geocodeWithGeocodio(address) {
  if (!process.env.GEOCODIO_API_KEY) return null;
  const endpoint = new URL("https://api.geocod.io/v1.6/geocode");
  endpoint.searchParams.set("q", address);
  endpoint.searchParams.set("api_key", process.env.GEOCODIO_API_KEY);
  endpoint.searchParams.set("limit", "1");
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`Geocodio returned ${response.status}`);
  const payload = await response.json();
  const location = payload?.results?.[0]?.location;
  if (!location || !Number.isFinite(Number(location.lat)) || !Number.isFinite(Number(location.lng))) return null;
  return [Number(location.lat), Number(location.lng)];
}

async function geocodeAddresses(addresses) {
  const input = [...new Set((Array.isArray(addresses) ? addresses : []).map((address) => String(address || "").trim()).filter(Boolean))];
  const keys = input.map(geocodeKey).filter(Boolean);
  await loadCachedCoordinates([...new Set(keys.filter((key) => !geocodeMemory.has(key)))]);
  const results = new Map();
  const missing = input.filter((address) => !geocodeMemory.has(geocodeKey(address)));
  let remoteCount = 0;
  for (let index = 0; index < missing.length; index += 4) {
    const batch = missing.slice(index, index + 4);
    const batchResults = await Promise.all(batch.map(async (address) => {
      const key = geocodeKey(address);
      try {
        const coords = await geocodeWithGeocodio(address);
        if (coords) {
          geocodeMemory.set(key, coords);
          await persistCoordinates(key, coords);
          remoteCount += 1;
          return { address, key, lat: coords[0], lon: coords[1], source: "geocodio" };
        }
      } catch (error) {
        console.warn(`[geocode] provider lookup failed for ${key}: ${error.message}`);
      }
      return { address, key, lat: null, lon: null, source: "not-found" };
    }));
    batchResults.forEach((result) => results.set(result.key, result));
  }
  input.forEach((address) => {
    const key = geocodeKey(address);
    const coords = geocodeMemory.get(key);
    if (coords) results.set(key, { address, key, lat: coords[0], lon: coords[1], source: missing.some((item) => geocodeKey(item) === key) ? "geocodio" : "mongo" });
    else if (!results.has(key)) results.set(key, { address, key, lat: null, lon: null, source: "not-found" });
  });
  return { results: input.map((address) => results.get(geocodeKey(address))), cached: input.length - remoteCount, geocoded: remoteCount };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 2_000_000) reject(new Error("Request body is too large.")); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "POST" && url.pathname === "/api/geocode") {
    readRequestBody(req)
      .then((body) => JSON.parse(body || "{}"))
      .then((payload) => geocodeAddresses(payload.addresses))
      .then((payload) => sendJson(res, 200, payload))
      .catch((error) => sendJson(res, 500, { error: error.message || "Geocoding failed." }));
    return;
  }
  if (url.pathname.startsWith("/vendor/")) {
    const requested = url.pathname.slice("/vendor/".length);
    const filePath = safePath(vendorDir, requested);
    serveFile(res, filePath);
    return;
  }
  let requested = decodeURIComponent(url.pathname);
  if (requested === "/" || requested === "") requested = "/index.html";
  const filePath = safePath(staticDir, requested);
  serveFile(res, filePath);
});

server.listen(port, () => {
  console.log(`ministering-visualizer listening on http://localhost:${port}`);
});
