import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const LEGACY_DB_PATH = path.join(REPO_ROOT, "surfaces.db");
const LEGACY_WORKSPACE = path.join(os.homedir(), "surface");

let dataDirCache: string | null = null;
let bootstrapped = false;

export function getDataDir(): string {
  if (dataDirCache) return dataDirCache;
  const explicit = process.env.SURFACE_DATA_DIR;
  dataDirCache = explicit
    ? path.resolve(explicit)
    : path.join(os.homedir(), ".surface");
  fs.mkdirSync(dataDirCache, { recursive: true });
  return dataDirCache;
}

export function getDbPath(): string {
  return path.join(getDataDir(), "db.sqlite");
}

export function getWorkspaceDir(): string {
  // SURFACE_WORKSPACE_DIR is a legacy override that points at the directory
  // containing the artifacts/ subfolder. New installs use the data dir directly.
  const override = process.env.SURFACE_WORKSPACE_DIR;
  const dir = override ? path.resolve(override) : getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function bootstrapDataDir(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  const dataDir = getDataDir();
  const dbPath = getDbPath();

  if (!fs.existsSync(dbPath) && fs.existsSync(LEGACY_DB_PATH)) {
    console.log(`[surface] migrating legacy DB ${LEGACY_DB_PATH} -> ${dbPath}`);
    fs.copyFileSync(LEGACY_DB_PATH, dbPath);
    for (const suffix of ["-wal", "-shm"]) {
      const legacy = LEGACY_DB_PATH + suffix;
      if (fs.existsSync(legacy)) fs.copyFileSync(legacy, dbPath + suffix);
    }
  }

  if (!process.env.SURFACE_WORKSPACE_DIR) {
    const legacyArtifacts = path.join(LEGACY_WORKSPACE, "artifacts");
    const newArtifacts = path.join(dataDir, "artifacts");
    if (fs.existsSync(legacyArtifacts) && !fs.existsSync(newArtifacts)) {
      console.log(`[surface] migrating legacy workspace ${legacyArtifacts} -> ${newArtifacts}`);
      fs.cpSync(legacyArtifacts, newArtifacts, { recursive: true });
    }
  }
}
