import { Router } from "express";
import { authRouter } from "./auth.js";
import { artifactsRouter } from "./artifacts.js";
import { actionsRouter } from "./actions.js";
import { codexRouter } from "./codex.js";
import { displayRouter } from "./display.js";
import { integrationsRouter } from "./integrations.js";

// One router per concern: auth/devices, artifact CRUD + serving, the action
// loop, display control + presence + SSE, and quarantined third-party proxies.
export const router = Router();

router.use(authRouter);
// actionsRouter must mount before artifactsRouter: both define routes under
// /artifacts/:id/…, and the artifacts file route is a greedy regex.
router.use(actionsRouter);
router.use(codexRouter);
router.use(artifactsRouter);
router.use(displayRouter);
router.use(integrationsRouter);
