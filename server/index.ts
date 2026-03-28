import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { initDb } from "./db.js";
import { router } from "./routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

initDb();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(router);
app.use(express.static(path.join(__dirname, "..", "client")));

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Surface server running on http://0.0.0.0:${PORT}`);
});
