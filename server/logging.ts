import fs from "fs";
import path from "path";

// Tee stdout/stderr into an append-only log file. Service supervisors on
// macOS and Windows have no journald equivalent, so the server owns its log
// file and `surface service logs` reads the same path on every platform.
// Original stream writes are preserved (systemd's journal still sees output).
export function setupFileLogging(file: string): void {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const stream = fs.createWriteStream(resolved, { flags: "a" });

  const stamp = (chunk: string): string => {
    const t = new Date().toISOString();
    return chunk
      .split("\n")
      .map((line) => (line ? `${t} ${line}` : line))
      .join("\n");
  };

  for (const std of [process.stdout, process.stderr]) {
    const original = std.write.bind(std);
    (std as { write: typeof std.write }).write = ((chunk: any, encoding?: any, cb?: any) => {
      try {
        stream.write(typeof chunk === "string" ? stamp(chunk) : chunk);
      } catch {
        // Logging must never take the service down.
      }
      return original(chunk, encoding, cb);
    }) as typeof std.write;
  }
}
