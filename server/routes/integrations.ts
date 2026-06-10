import { Router } from "express";
import dns from "node:dns/promises";
import net from "node:net";

// Third-party proxies quarantined behind one router: the Nexlayer deployment
// API, the OpenRouter chat proxy, and the PDF X-Frame-Options bypass. None of
// these touch Surface's own data model.

export const integrationsRouter = Router();

// ── Nexlayer proxy ──

const NEXLAYER_API = "https://app.nexlayer.io";

integrationsRouter.post("/api/nexlayer/deploy", async (req, res) => {
  try {
    const yaml = req.body.yaml;
    if (!yaml) { res.status(400).json({ error: "yaml is required" }); return; }
    const url = req.body.sessionToken
      ? `${NEXLAYER_API}/startUserDeployment?sessionToken=${req.body.sessionToken}`
      : `${NEXLAYER_API}/startUserDeployment`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/x-yaml" },
      body: yaml,
    });
    const data = await upstream.text();
    res.status(upstream.status).setHeader("Content-Type", "application/json").send(data);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

integrationsRouter.post("/api/nexlayer/extend", async (req, res) => {
  try {
    const { applicationName, sessionToken } = req.body;
    const upstream = await fetch(`${NEXLAYER_API}/extendDeployment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationName, sessionToken }),
    });
    const data = await upstream.text();
    res.status(upstream.status).send(data);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

integrationsRouter.get("/api/nexlayer/status", async (req, res) => {
  try {
    const token = req.query.sessionToken as string;
    if (!token) { res.status(400).json({ error: "sessionToken required" }); return; }
    const upstream = await fetch(`${NEXLAYER_API}/getReservations?sessionToken=${token}`);
    const data = await upstream.text();
    res.status(upstream.status).setHeader("Content-Type", "application/json").send(data);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// ── LLM completions proxy (OpenRouter) ──

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";
const CHAT_RATE_LIMIT = Math.max(1, Number(process.env.SURFACE_CHAT_RATE_LIMIT || 30));
const CHAT_RATE_WINDOW_MS = 60_000;
const chatRateState = { count: 0, windowStart: 0 };

function chatRateAllow(): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  if (now - chatRateState.windowStart >= CHAT_RATE_WINDOW_MS) {
    chatRateState.windowStart = now;
    chatRateState.count = 0;
  }
  if (chatRateState.count >= CHAT_RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((chatRateState.windowStart + CHAT_RATE_WINDOW_MS - now) / 1000));
    return { ok: false, retryAfter };
  }
  chatRateState.count++;
  return { ok: true };
}

integrationsRouter.post("/api/chat", async (req, res) => {
  const gate = chatRateAllow();
  if (!gate.ok) {
    res.setHeader("Retry-After", String(gate.retryAfter));
    res.status(429).json({ error: `chat rate limit exceeded (${CHAT_RATE_LIMIT}/min)`, retry_after: gate.retryAfter });
    return;
  }
  if (!OPENROUTER_API_KEY) {
    res.status(500).json({ error: "OPENROUTER_API_KEY not configured" });
    return;
  }
  const { messages, model, stream } = req.body;
  if (!messages) {
    res.status(400).json({ error: "messages is required" });
    return;
  }
  try {
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || OPENROUTER_MODEL,
        messages,
        stream: stream || false,
      }),
    });
    if (!upstream.ok) {
      const err = await upstream.text();
      res.status(upstream.status).json({ error: err });
      return;
    }
    if (stream && upstream.body) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); return; }
          res.write(Buffer.from(value));
        }
      };
      pump().catch(() => res.end());
    } else {
      const data = await upstream.json();
      res.json(data);
    }
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// Returns true if the IP literal is loopback, private (RFC1918), link-local,
// IPv4-mapped IPv6, ULA, or otherwise off-limits for outbound SSRF.
function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
    if (lower.startsWith("ff")) return true; // multicast
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice(7);
      if (net.isIP(v4) === 4) return isPrivateIp(v4);
    }
    return false;
  }
  return true; // not an IP literal: caller should resolve first
}

async function resolvesPrivate(hostname: string): Promise<boolean> {
  if (net.isIP(hostname) !== 0) return isPrivateIp(hostname);
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    if (addresses.length === 0) return true;
    return addresses.some((a) => isPrivateIp(a.address));
  } catch {
    return true; // fail-closed
  }
}

// PDF proxy — bypasses X-Frame-Options so surfaces can embed PDFs.
// Refuses URLs that resolve to loopback / RFC1918 / link-local / metadata IPs
// to defeat trivial SSRF through this endpoint.
integrationsRouter.get("/proxy/pdf", async (req, res) => {
  const url = req.query.url as string;
  if (!url || !/^https?:\/\//.test(url)) {
    res.status(400).json({ error: "url query param required" });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    res.status(400).json({ error: "invalid url" });
    return;
  }
  if (await resolvesPrivate(parsed.hostname)) {
    res.status(403).json({ error: "host resolves to a private or loopback address" });
    return;
  }
  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "Surface/1.0" },
      redirect: "manual",
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      // Don't follow redirects automatically — a redirect could bounce us into
      // a private IP. The caller can resolve the redirect target themselves.
      res.status(502).json({ error: "upstream redirected; pass the final URL directly" });
      return;
    }
    if (!upstream.ok) {
      res.status(upstream.status).send(`Upstream ${upstream.status}`);
      return;
    }
    const ct = upstream.headers.get("content-type") || "application/pdf";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=3600");
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});
