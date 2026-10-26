#!/usr/bin/env node
/**
 * SurePass prototype, local dev only. Serves the static page and mounts the
 * same handler Netlify runs as a function (../netlify/functions/surepass.mjs)
 * at /api/surepass/verify. SUREPASS_API_KEY is read from ../../ninto/.env or a
 * local .env (see package.json's serve script).
 */
import express from "express";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import surepass from "../netlify/functions/surepass.mjs";

const PORT = process.env.PORT || 4000;
const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.post("/api/surepass/verify", express.raw({ type: () => true }), async (req, res) => {
  const response = await surepass(new Request(`http://localhost${req.originalUrl}`, {
    method: req.method,
    headers: { "content-type": "application/json" },
    body: Buffer.isBuffer(req.body) ? req.body : undefined
  }));
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.send(Buffer.from(await response.arrayBuffer()));
});

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`SurePass prototype running at http://localhost:${PORT}`);
  console.log(`SurePass: ${process.env.SUREPASS_API_KEY ? "API key loaded" : "no SUREPASS_API_KEY -- verify calls will fail"}`);
});
