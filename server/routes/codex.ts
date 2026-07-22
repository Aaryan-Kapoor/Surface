import { Router } from "express";
import { getDb } from "../db.js";
import { registerAgentSession, countAgentSessions } from "../agentSessions.js";
import { codexBridgeStatus } from "../codexBridge.js";
import { requireSystem } from "./helpers.js";

// Agent-session registry + bridge introspection (docs/interaction/codex.md).
// Registration is fed by the codex SessionStart hook (`surface codex-hook`);
// both endpoints are system-plane: paired devices have no business here.

export const codexRouter = Router();

codexRouter.post("/codex/sessions/register", (req, res) => {
  if (!requireSystem(req, res)) return;
  const { kind, session_id, pid, cwd, transcript_path } = req.body || {};
  try {
    registerAgentSession(getDb(), {
      kind: kind || "codex",
      session_id,
      pid: typeof pid === "number" ? pid : undefined,
      cwd: typeof cwd === "string" ? cwd : undefined,
      transcript_path: typeof transcript_path === "string" ? transcript_path : undefined,
    });
    res.status(204).end();
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

codexRouter.get("/codex/status", (req, res) => {
  if (!requireSystem(req, res)) return;
  res.json({
    ...codexBridgeStatus(),
    registered_sessions: countAgentSessions(getDb()),
  });
});
