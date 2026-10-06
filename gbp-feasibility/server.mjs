#!/usr/bin/env node
/**
 * NINTO-550 feasibility check. Serves the static per-visitor OAuth app
 * (index.html + app.js) -- real Google account picker via Google Identity
 * Services, no backend needed. Netlify serves the same files directly.
 * See ../audit/gbp-feasibility-plan.md.
 */
import express from "express";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.PORT || 8000;
const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
