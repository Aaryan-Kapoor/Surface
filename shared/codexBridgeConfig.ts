import fs from "node:fs";
import path from "node:path";

export interface CodexBridgeConfig {
  version: 1;
  transport: "websocket";
  endpoint: string;
  codex_bin: string;
  managed: boolean;
  // Deprecated migration fields from the first Windows prototype. New
  // installs never persist CODEX_APP_SERVER_WS_URL in the user environment.
  desktop_env_set?: string;
  desktop_env_previous?: string | null;
  updated_at: string;
}

export function codexBridgeConfigPath(dataDir: string): string {
  return path.join(dataDir, "codex-bridge.json");
}

export function readCodexBridgeConfig(dataDir: string): CodexBridgeConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(codexBridgeConfigPath(dataDir), "utf8"));
    if (
      parsed?.version !== 1 || parsed?.transport !== "websocket" ||
      typeof parsed.endpoint !== "string" || !/^wss?:\/\//.test(parsed.endpoint) ||
      typeof parsed.codex_bin !== "string" || typeof parsed.managed !== "boolean"
    ) return null;
    return parsed as CodexBridgeConfig;
  } catch {
    return null;
  }
}

export function writeCodexBridgeConfig(dataDir: string, config: CodexBridgeConfig): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = codexBridgeConfigPath(dataDir);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, 0o600); } catch {}
}
