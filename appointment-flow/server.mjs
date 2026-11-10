#!/usr/bin/env node
/**
 * Appointment-flow POC, local dev only. Serves the static patient and clinic
 * apps and mounts the same handlers Netlify runs as functions: Razorpay
 * (../netlify/functions/razorpay.mjs) at /api/razorpay/* and the AI arrival
 * call (../netlify/functions/ai-call.mjs) at /api/ai-call/*, and Google Maps
 * routes (../netlify/functions/routes.mjs) at /api/routes/*, and the ElevenLabs
 * voice agent (../netlify/functions/elevenlabs.mjs) at /api/elevenlabs/*. Put keys in .env
 * (see .env.example); without them the apps use the simulated gateway,
 * scripted calls and estimated routes.
 * See ../audit/appointment-flow-plan.md.
 */
import express from "express";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import razorpay from "../netlify/functions/razorpay.mjs";
import aiCall from "../netlify/functions/ai-call.mjs";
import routes from "../netlify/functions/routes.mjs";
import elevenlabs from "../netlify/functions/elevenlabs.mjs";

const PORT = process.env.PORT || 8000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const FORWARDED_HEADERS = ["content-type", "x-razorpay-signature", "elevenlabs-signature"];

const app = express();

// Runs a Netlify-style (Request -> Response) handler for an Express route.
const mount = handler => async (req, res) => {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) if (req.headers[name]) headers.set(name, req.headers[name]);
  const hasBody = !["GET", "HEAD"].includes(req.method) && Buffer.isBuffer(req.body);
  const response = await handler(new Request(`http://localhost${req.originalUrl}`, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined
  }));
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.send(Buffer.from(await response.arrayBuffer()));
};

app.all("/api/razorpay/*", express.raw({ type: () => true }), mount(razorpay));
app.all("/api/ai-call/*", express.raw({ type: () => true }), mount(aiCall));
app.all("/api/routes/*", express.raw({ type: () => true }), mount(routes));
app.all("/api/elevenlabs/*", express.raw({ type: () => true }), mount(elevenlabs));

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Razorpay: ${process.env.RAZORPAY_KEY_ID ? "test keys loaded" : "no keys -- simulated gateway"}`);
  console.log(`Routes: ${process.env.GOOGLE_MAPS_API_KEY ? "Google Maps Routes API" : "no GOOGLE_MAPS_API_KEY -- built-in estimates"}`);
  console.log(`AI calls: ${process.env.ANTHROPIC_API_KEY ? "Claude (live)" : "no ANTHROPIC_API_KEY -- scripted calls"}`);
  console.log(`ElevenLabs: ${process.env.ELEVENLABS_API_KEY ? `key set${process.env.ELEVENLABS_AGENT_ID ? ", agent set" : ", no agent yet (POST /api/elevenlabs/setup)"}${process.env.ELEVENLABS_PHONE_NUMBER_ID ? ", phone number set" : ""}` : "no ELEVENLABS_API_KEY"}`);
});
