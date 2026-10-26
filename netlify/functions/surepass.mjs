/**
 * SurePass prototype -- a thin proxy to SurePass's health-professional
 * verification APIs so the API key never reaches the browser. Served by
 * Netlify at /api/surepass/verify and, for local dev, by
 * surepass-prototype/server.mjs (which imports this same handler).
 *
 * The caller sends professionalType + whatever fields that type needs; this
 * decides which SurePass product to call, so callers never need to know
 * SurePass's product/path naming.
 *
 * Env: SUREPASS_API_KEY (sandbox token -- every product URL below is on
 * sandbox.surepass.app).
 */
export const config = { path: "/api/surepass/verify" };

// One SurePass product per professionalType. `enabled: false` means the
// product's contract/enum is still unresolved (BHMS/BDS-MDS's state_name is a
// fixed enum we haven't been given the values for -- every guess tried came
// back "not a valid choice") -- by request, only MBBS ships for now.
const PROFESSIONAL_TYPE_PRODUCTS = {
  "modern-medicine": {
    label: "Doctor (MBBS)",
    url: "https://sandbox.surepass.app/api/v1/doctor/doctor-verification",
    fields: ["registration_number", "registration_year"],
    enabled: true
  },
  homeopathy: {
    label: "BHMS Doctor",
    url: "https://sandbox.surepass.app/api/v1/doctor/bhms/verification",
    fields: ["state_name", "id_number"],
    enabled: false
  },
  dentist: {
    label: "BDS/MDS Doctor",
    url: "https://sandbox.surepass.app/api/v1/doctor/bds-mds/verification",
    fields: ["state_name", "id_number"],
    enabled: false
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export default async function handler(req) {
  if (req.method !== "POST") return json({ success: false, message: "Use POST." }, 405);

  const apiKey = process.env.SUREPASS_API_KEY ?? "";
  if (!apiKey) return json({ success: false, message: "SUREPASS_API_KEY is not set on the server." }, 500);

  const { professionalType, ...fields } = await req.json().catch(() => ({}));
  const product = PROFESSIONAL_TYPE_PRODUCTS[professionalType];

  if (!product) {
    return json({ success: false, message: `Unknown professionalType "${professionalType}".` }, 400);
  }
  if (!product.enabled) {
    return json({ success: false, message: `Verification for "${product.label}" isn't supported yet.` }, 400);
  }

  const body = {};
  product.fields.forEach((field) => {
    body[field] = fields[field];
  });

  console.log(`[verify:${professionalType}] request ->`, product.url, body);

  try {
    const surePassResponse = await fetch(product.url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await surePassResponse.json().catch(() => ({}));
    console.log(`[verify:${professionalType}] response <-`, surePassResponse.status, data);
    return json(data, surePassResponse.status);
  } catch (error) {
    console.error(`[verify:${professionalType}] request failed`, error);
    return json({ error: "Couldn't reach SurePass.", detail: error.message }, 502);
  }
}
