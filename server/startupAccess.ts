import { networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";
import { QrCode } from "./qrCode.js";

type NetworkInterfacesMap = ReturnType<typeof networkInterfaces>;

export interface HeadlessAccessInfo {
  connectionString: string;
  token: string;
  pairingUrl: string;
}

export function isWildcardHost(host: string | undefined): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

export function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function normalizeHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isIpv4Family(family: string | number): boolean {
  return family === "IPv4" || family === 4;
}

function isIpv6Family(family: string | number): boolean {
  return family === "IPv6" || family === 6;
}

export function resolveConnectionHost(
  bindHost: string | undefined,
  interfaces: NetworkInterfacesMap = networkInterfaces(),
): string {
  if (!bindHost) return "localhost";
  if (!isWildcardHost(bindHost)) return normalizeHost(bindHost);

  const entries = Object.values(interfaces).flatMap((entry) => entry ?? []);
  const externalIpv4 = entries.find((entry) => !entry.internal && isIpv4Family(entry.family));
  if (externalIpv4) return externalIpv4.address;

  const externalIpv6 = entries.find((entry) => !entry.internal && isIpv6Family(entry.family));
  return externalIpv6 ? normalizeHost(externalIpv6.address) : "localhost";
}

export function resolveListeningPort(address: AddressInfo | string | null, fallbackPort: number): number {
  return typeof address === "object" && address !== null ? address.port : fallbackPort;
}

export function resolveConnectionString(bindHost: string | undefined, port: number): string {
  return `http://${formatHostForUrl(resolveConnectionHost(bindHost))}:${port}`;
}

export function buildPairingUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/pair";
  url.searchParams.delete("token");
  url.hash = new URLSearchParams([["token", token]]).toString();
  return url.toString();
}

export function buildHostedPairingUrl(hostedBaseUrl: string, backendBaseUrl: string, token: string): string {
  const url = new URL("/pair", hostedBaseUrl);
  url.searchParams.set("host", backendBaseUrl);
  url.searchParams.delete("token");
  url.hash = new URLSearchParams([["token", token]]).toString();
  return url.toString();
}

export function renderTerminalQrCode(value: string, margin = 2): string {
  const qrCode = QrCode.encodeText(value, QrCode.Ecc.MEDIUM);
  const rows: string[] = [];
  const isDark = (x: number, y: number): boolean =>
    x >= 0 && x < qrCode.size && y >= 0 && y < qrCode.size && qrCode.getModule(x, y);

  for (let y = -margin; y < qrCode.size + margin; y += 2) {
    let row = "";
    for (let x = -margin; x < qrCode.size + margin; x++) {
      const topDark = isDark(x, y);
      const bottomDark = isDark(x, y + 1);
      row += topDark ? (bottomDark ? "█" : "▀") : bottomDark ? "▄" : " ";
    }
    rows.push(row);
  }

  return rows.join("\n");
}

export function formatHeadlessAccessOutput(accessInfo: HeadlessAccessInfo, options: { qr?: boolean } = {}): string {
  return [
    "Surface server is ready.",
    `Connection string: ${accessInfo.connectionString}`,
    `Token: ${accessInfo.token}`,
    `Pairing URL: ${accessInfo.pairingUrl}`,
    "",
    options.qr === false ? "" : renderTerminalQrCode(accessInfo.pairingUrl),
    "",
  ]
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n");
}
