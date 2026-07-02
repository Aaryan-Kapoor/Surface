import type Database from "better-sqlite3";

// Append-only chunk store for stream surfaces (docs/templates/stream.md).
// Ring buffer per surface: old chunks drop past the cap so a long-running
// log never grows unbounded.

export const DEFAULT_STREAM_CAP = 2000;

export interface StreamChunk {
  artifact_id: string;
  seq: number;
  kind: "text" | "md";
  content: string;
  created_at: string;
}

export function appendChunks(
  db: Database.Database,
  artifactId: string,
  chunks: Array<{ kind?: string; content: string }>,
  cap: number = DEFAULT_STREAM_CAP,
): StreamChunk[] {
  if (!chunks.length) return [];
  const inserted: StreamChunk[] = [];
  const tx = db.transaction(() => {
    const row = db
      .prepare(`SELECT max(seq) AS seq FROM surface_stream_chunks WHERE artifact_id = ?`)
      .get(artifactId) as { seq: number | null };
    let seq = row.seq || 0;
    const insert = db.prepare(
      `INSERT INTO surface_stream_chunks (artifact_id, seq, kind, content)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
    );
    for (const chunk of chunks) {
      seq++;
      const kind = chunk.kind === "md" ? "md" : "text";
      inserted.push(insert.get(artifactId, seq, kind, String(chunk.content ?? "")) as StreamChunk);
    }
    db.prepare(
      `DELETE FROM surface_stream_chunks WHERE artifact_id = ? AND seq <= ?`,
    ).run(artifactId, seq - Math.max(1, cap));
  });
  tx();
  return inserted;
}

export function getChunks(db: Database.Database, artifactId: string): StreamChunk[] {
  return db
    .prepare(`SELECT * FROM surface_stream_chunks WHERE artifact_id = ? ORDER BY seq ASC`)
    .all(artifactId) as StreamChunk[];
}
