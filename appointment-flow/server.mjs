#!/usr/bin/env node
/**
 * Appointment-flow POC, local dev only. Serves the static patient and clinic
 * apps and mounts the same Razorpay handler Netlify runs as a function
 * (../netlify/functions/razorpay.mjs) at /api/razorpay/*. Put test keys in
 * .env (see .env.example); without them the apps use the simulated gateway.
 * See ../audit/appointment-flow-plan.md.
 */
import express from "express";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import razorpay from "../netlify/functions/razorpay.mjs";

const PORT = process.env.PORT || 8000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const FORWARDED_HEADERS = ["content-type", "x-razorpay-signature"];

const app = express();

app.all("/api/razorpay/*", express.raw({ type: () => true }), async (req, res) => {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) if (req.headers[name]) headers.set(name, req.headers[name]);
  const hasBody = !["GET", "HEAD"].includes(req.method) && Buffer.isBuffer(req.body);
  const response = await razorpay(new Request(`http://localhost${req.originalUrl}`, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined
  }));
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.send(Buffer.from(await response.arrayBuffer()));
});

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Razorpay: ${process.env.RAZORPAY_KEY_ID ? "test keys loaded" : "no keys -- simulated gateway"}`);
});
