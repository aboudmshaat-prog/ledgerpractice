/*
 * LedgerPractice — single-user server (pure Node.js, zero dependencies)
 * -------------------------------------------------------------------
 * - Serves the app from ./public
 * - Stores all data centrally in ./data/data.json (atomic writes + backups)
 * - Protects everything behind ONE password (env APP_PASSWORD)
 *
 * Required environment variables:
 *   APP_PASSWORD    the password you type to unlock the app
 * Optional:
 *   PORT            default 3000
 *   DATA_DIR        default ./data
 *   SESSION_SECRET  auto-generated & saved if not provided
 *   COOKIE_SECURE   set to "1" in production (behind HTTPS/Caddy)
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFile } = require("child_process");

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const MAX_BACKUPS = 30;
const SESSION_DAYS = 7;
const MAX_BODY = 12 * 1024 * 1024; // 12 MB

const PASSWORD = process.env.APP_PASSWORD;
if (!PASSWORD) {
  console.error("FATAL: APP_PASSWORD environment variable is not set. Refusing to start.");
  process.exit(1);
}

// --- ensure folders exist ---
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// --- session secret (persist so logins survive restarts) ---
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  const secFile = path.join(DATA_DIR, ".session_secret");
  try {
    SECRET = fs.readFileSync(secFile, "utf8").trim();
  } catch (e) {
    SECRET = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(secFile, SECRET, { mode: 0o600 });
  }
}

const EMPTY = { clients: [], active: null, opening: {}, statements: {} };

// --- token helpers (stateless, signed, with expiry) ---
function sign(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}
function makeToken() {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const payload = String(exp);
  return Buffer.from(payload).toString("base64url") + "." + sign(payload);
}
function validToken(token) {
  if (!token || token.indexOf(".") < 0) return false;
  const [b64, sig] = token.split(".");
  let payload;
  try { payload = Buffer.from(b64, "base64url").toString("utf8"); } catch (e) { return false; }
  const sigBuf = Buffer.from(sig || "", "hex");
  const expBuf = Buffer.from(sign(payload), "hex");
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  const exp = parseInt(payload, 10);
  return Number.isFinite(exp) && Date.now() < exp;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  return validToken(parseCookies(req).sid);
}

// --- data storage (atomic write + rolling backups) ---
function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch (e) { return EMPTY; }
}
function writeData(obj) {
  // backup current before overwriting
  if (fs.existsSync(DATA_FILE)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try { fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, `data-${stamp}.json`)); } catch (e) {}
    // prune old backups
    try {
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith("data-")).sort();
      while (files.length > MAX_BACKUPS) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    } catch (e) {}
  }
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, DATA_FILE); // atomic on same filesystem
}

// --- helpers ---
function send(res, code, body, headers = {}) {
  res.writeHead(code, Object.assign({ "X-Content-Type-Options": "nosniff" }, headers));
  res.end(body);
}
function json(res, code, obj, headers = {}) {
  send(res, code, JSON.stringify(obj), Object.assign({ "Content-Type": "application/json" }, headers));
}
function readBody(req, cb) {
  let data = "", tooBig = false;
  req.on("data", c => { data += c; if (data.length > MAX_BODY) { tooBig = true; req.destroy(); } });
  req.on("end", () => { if (!tooBig) cb(data); });
}
function cookie(value, maxAgeSec) {
  let c = `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
  if (process.env.COOKIE_SECURE === "1") c += "; Secure";
  return c;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };
function serveStatic(res, urlPath) {
  let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden"); // path traversal guard
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, buf, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
  });
}

// --- Lloyds statement parser (from `pdftotext -layout` output) ---
function parseLloyds(text) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim());
  const bals = [...text.matchAll(/Balance on \d{2} [A-Za-z]+ \d{4}[^£]*£([\d,]+\.\d{2})/g)]
    .map(m => Math.round(parseFloat(m[1].replace(/,/g, "")) * 100));
  const opening = bals.length ? bals[0] : 0;
  const closing = bals.length > 1 ? bals[1] : null;
  const MN = { January:1,February:2,March:3,April:4,May:5,June:6,July:7,August:8,September:9,October:10,November:11,December:12 };
  const dm = [...text.matchAll(/Balance on \d{2} ([A-Za-z]+) (\d{4})/g)];
  let ym = null;
  if (dm.length) { const last = dm[dm.length - 1]; const mo = MN[last[1]]; if (mo) ym = last[2] + "-" + String(mo).padStart(2, "0"); }
  const dateRe = /^(\d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2})\b/;
  const numRe = /-?\d{1,3}(?:,\d{3})*\.\d{2}/g;
  let pendingDesc = "", prev = opening; const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === "Description") { for (let j = i + 1; j < lines.length; j++) { if (lines[j]) { pendingDesc = lines[j]; break; } } continue; }
    const dm = l.match(dateRe);
    if (dm) {
      const nums = l.match(numRe);
      if (nums && nums.length >= 2) {
        const bal = Math.round(parseFloat(nums[nums.length - 1].replace(/,/g, "")) * 100);
        rows.push({ date: dm[1], description: pendingDesc || "Transaction", amount: (bal - prev) / 100, balance: bal / 100 });
        prev = bal; pendingDesc = "";
      }
    }
  }
  return { opening: opening / 100, closing: closing == null ? null : closing / 100, ym, computed: prev / 100, count: rows.length, rows };
}

// --- server ---
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  // login
  if (req.method === "POST" && url === "/login") {
    return readBody(req, body => {
      let pw = "";
      try { pw = (JSON.parse(body || "{}").password) || ""; } catch (e) {}
      const ok = Buffer.byteLength(pw) === Buffer.byteLength(PASSWORD) &&
                 crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(PASSWORD));
      if (ok) return json(res, 200, { ok: true }, { "Set-Cookie": cookie(makeToken(), SESSION_DAYS * 86400) });
      return json(res, 401, { error: "Incorrect password" });
    });
  }

  // logout
  if (req.method === "POST" && url === "/logout") {
    return json(res, 200, { ok: true }, { "Set-Cookie": cookie("", 0) });
  }

  // data API (auth required)
  if (url === "/api/data") {
    if (!isAuthed(req)) return json(res, 401, { error: "Not authenticated" });
    if (req.method === "GET") return json(res, 200, readData());
    if (req.method === "POST") {
      return readBody(req, body => {
        let obj;
        try { obj = JSON.parse(body); } catch (e) { return json(res, 400, { error: "Invalid JSON" }); }
        if (!obj || typeof obj !== "object" || !Array.isArray(obj.clients))
          return json(res, 400, { error: "Unexpected data shape" });
        try { writeData(obj); } catch (e) { return json(res, 500, { error: "Write failed" }); }
        return json(res, 200, { ok: true, savedAt: new Date().toISOString() });
      });
    }
    return json(res, 405, { error: "Method not allowed" });
  }

  // PDF statement parsing (auth required) — uses system `pdftotext`
  if (url === "/api/parse-pdf") {
    if (!isAuthed(req)) return json(res, 401, { error: "Not authenticated" });
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    const chunks = []; let size = 0, tooBig = false;
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { tooBig = true; req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (tooBig) return json(res, 413, { error: "File too large" });
      const tmp = path.join(os.tmpdir(), "lp-" + crypto.randomBytes(6).toString("hex") + ".pdf");
      try { fs.writeFileSync(tmp, Buffer.concat(chunks)); } catch (e) { return json(res, 500, { error: "Could not save upload" }); }
      execFile("pdftotext", ["-layout", tmp, "-"], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        fs.unlink(tmp, () => {});
        if (err) return json(res, 500, { error: "pdftotext failed — is poppler-utils installed on the server?" });
        try { return json(res, 200, parseLloyds(stdout)); }
        catch (e) { return json(res, 500, { error: "Could not parse the statement" }); }
      });
    });
    return;
  }

  // health check
  if (url === "/healthz") return send(res, 200, "ok");

  // static app
  if (req.method === "GET") return serveStatic(res, url);
  return send(res, 404, "Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`LedgerPractice server on http://127.0.0.1:${PORT}  (data: ${DATA_DIR})`);
});
