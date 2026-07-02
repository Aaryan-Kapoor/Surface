import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export interface SafeHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export class OutboundBlockedError extends Error {
  status = 403;
}

export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 / Tailscale CGNAT
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("ff")) return true;
    if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));
    return false;
  }
  return true;
}

function looksLikeNonCanonicalIpLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (net.isIP(h) !== 0) return false;
  if (/^(?:0x[0-9a-f]+|\d+)$/.test(h)) return true;
  if (/^(?:0x[0-9a-f]+|0[0-7]+|\d+)(?:\.(?:0x[0-9a-f]+|0[0-7]+|\d+))*$/.test(h)) return true;
  return false;
}

async function resolvePublic(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  if (looksLikeNonCanonicalIpLiteral(hostname)) {
    throw new OutboundBlockedError("non-canonical IP literal is not allowed");
  }
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isPrivateIp(hostname)) throw new OutboundBlockedError("host resolves to a private or loopback address");
    return { address: hostname, family: literalFamily as 4 | 6 };
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new OutboundBlockedError("host could not be resolved safely");
  }
  if (!addresses.length) throw new OutboundBlockedError("host could not be resolved safely");
  const blocked = addresses.find((a) => isPrivateIp(a.address));
  if (blocked) throw new OutboundBlockedError("host resolves to a private or loopback address");
  const first = addresses[0];
  return { address: first.address, family: first.family as 4 | 6 };
}

export async function safeHttpRequest(
  rawUrl: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<SafeHttpResponse> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OutboundBlockedError("url must use http(s)");
  }
  const vetted = await resolvePublic(parsed.hostname);
  const transport = parsed.protocol === "https:" ? https : http;
  const headers = { ...(opts.headers || {}) };
  if (!headers.Host && !headers.host) headers.Host = parsed.host;

  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: opts.method || "GET",
      headers,
      timeout: opts.timeoutMs || 30_000,
      lookup: (_hostname, _options, cb) => cb(null, vetted.address, vetted.family),
    }, (upstream) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const maxBytes = opts.maxBytes || 64 * 1024 * 1024;
      upstream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy(new Error(`upstream response exceeded ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      upstream.on("end", () => {
        resolve({
          status: upstream.statusCode || 0,
          statusText: upstream.statusMessage || "",
          headers: upstream.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error("outbound request timed out")));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
