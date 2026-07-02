import type { Role } from "./auth.js";

export interface AuthContext {
  role: Role;
  via: "loopback" | "cookie" | "bearer" | "content-port";
  sessionId?: string;
  label?: string | null;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export {};
