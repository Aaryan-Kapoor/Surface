import fs from "fs";
import os from "os";
import path from "path";

let dataDirCache: string | null = null;

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
  getDataDir();
}
