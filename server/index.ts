import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { initDb } from "./db.js";
import { router } from "./routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BIND = process.env.SURFACE_BIND || "127.0.0.1";
const TOKEN = process.env.SURFACE_TOKEN || "";

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);
const isLoopbackBind = LOOPBACK_ADDRS.has(BIND);

if (!isLoopbackBind && !TOKEN) {
  console.error(
    [
      "Surface refuses to bind on a non-loopback address without SURFACE_TOKEN set.",
      "Either:",
      "  - keep SURFACE_BIND=127.0.0.1 (default), or",
      "  - set SURFACE_TOKEN to a strong random value (see SECURITY.md).",
    ].join("\n"),
  );
  process.exit(1);
}

initDb();

const app = express();
app.use(express.json({ limit: "10mb" }));

// Auth: loopback is trusted; non-loopback requires SURFACE_TOKEN via Bearer
// header, ?token=, or surface_token cookie. A valid query-param auth sets the
// cookie so a browser opening `http://host:port/?token=...` once can then load
// `/style.css`, `/app.js`, and every API endpoint without the token in the URL.
app.use((req, res, next) => {
  const remote = req.socket.remoteAddress || "";
  if (LOOPBACK_ADDRS.has(remote)) return next();
  if (!TOKEN) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const header = req.header("Authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "");
  const query = typeof req.query.token === "string" ? req.query.token : "";
  const cookieHeader = req.header("Cookie") || "";
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)surface_token=([^;]+)/);
  const cookie = cookieMatch ? decodeURIComponent(cookieMatch[1]) : "";

  if (bearer !== TOKEN && query !== TOKEN && cookie !== TOKEN) {
    res.status(401).json({ error: "Invalid or missing token" });
    return;
  }
  if (query === TOKEN && cookie !== TOKEN) {
    res.setHeader(
      "Set-Cookie",
      `surface_token=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
    );
  }
  next();
});

app.use(router);
app.use("/demos", express.static(path.join(__dirname, "..", "examples", "demos")));
app.use(express.static(path.join(__dirname, "..", "client")));

app.listen(PORT, BIND, () => {
  console.log(`Surface server running on http://${BIND}:${PORT}`);
});
