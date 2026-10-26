// Reads SUREPASS_API_KEY from the env -- run via `npm run check` (see
// package.json), which loads ../../ninto/.env or a local .env.
const API_KEY = process.env.SUREPASS_API_KEY;
if (!API_KEY) {
  console.error("SUREPASS_API_KEY not set -- expected it in ../../ninto/.env or ./.env.");
  process.exit(1);
}

// Confirmed live in Phase 0: all three share sandbox.surepass.app with this
// (sandbox) token — the doctor-verification curl example's kyc-api.surepass.app
// host is SurePass's production host and 401s a sandbox token.
const PRODUCTS = {
  doctor: {
    url: "https://sandbox.surepass.app/api/v1/doctor/doctor-verification",
    sample: { registration_number: "12345", registration_year: "1900" },
  },
  bhms: {
    url: "https://sandbox.surepass.app/api/v1/doctor/bhms/verification",
    sample: { state_name: "chhattisgarh", id_number: "0002" },
  },
  "bds-mds": {
    url: "https://sandbox.surepass.app/api/v1/doctor/bds-mds/verification",
    sample: { state_name: "maharashtra", id_number: "A-101" },
  },
};

// Usage:
//   npm run check --                      -> runs all three with their sample payloads
//   npm run check -- doctor                -> runs just "doctor" with its sample payload
//   npm run check -- bhms state_name=kerala id_number=1234   -> override fields
async function checkProduct(key, overrides) {
  const product = PRODUCTS[key];
  if (!product) {
    console.error(
      `Unknown product "${key}". Known: ${Object.keys(PRODUCTS).join(", ")}`,
    );
    return;
  }
  const body = { ...product.sample, ...overrides };

  console.log(`\n=== ${key} ===`);
  console.log("POST", product.url);
  console.log("body:", body);

  try {
    const response = await fetch(product.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    console.log(`HTTP ${response.status}`);
    console.log(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Request failed:", error.message);
  }
}

async function main() {
  const [productArg, ...fieldArgs] = process.argv.slice(2);
  const overrides = Object.fromEntries(
    fieldArgs.map((arg) => arg.split("=").map((s) => s.trim())),
  );

  const productsToRun = productArg ? [productArg] : Object.keys(PRODUCTS);
  for (const key of productsToRun) {
    await checkProduct(key, productArg ? overrides : {});
  }
}

main();
