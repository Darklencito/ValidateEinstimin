// Sondeo de la API de EmailAwesome. NO imprime la clave.
//
// Qué averigua:
//  1) ¿Se puede crear una validación SIN results_callback?
//  2) ¿Se puede consultar el resultado después con el id (sin callback)?
//
// Uso (PowerShell), en tu propia terminal:
//   $env:EMAILAWESOME_API_KEY="tu_clave"; node scripts/ea-test.js
//   (opcional) $env:EA_TEST_EMAIL="alguien@gmail.com"
//
// Gasta 1 crédito (una sola validación). Los GET no consumen.

const key = process.env.EMAILAWESOME_API_KEY;
if (!key) {
  console.error("Falta la variable EMAILAWESOME_API_KEY");
  process.exit(1);
}
const email = process.env.EA_TEST_EMAIL || "john.smith@test.com";
const base = "https://api.emailawesome.com/api/validations/email_validation";
const headers = { Accept: "application/json", "x-api-key": key };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(label, url, init = {}) {
  try {
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    const text = (await res.text()).slice(0, 700);
    console.log(`\n[${label}] HTTP ${res.status}\n${text}`);
    try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null }; }
  } catch (e) {
    console.log(`\n[${label}] error de red: ${e.message}`);
    return { status: 0, json: null };
  }
}

(async () => {
  console.log(`Probando con: ${email}`);

  // 1) Crear la validación sin callback
  const created = await call("POST sin callback", base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

  const id = created.json && created.json.id;
  if (!id) {
    console.log("\n>>> No se obtuvo un id. Pega esta salida en el chat (sin la clave).");
    return;
  }

  // 2) Intentar consultar el resultado por id con varias formas habituales
  console.log("\nEsperando 6 s antes de consultar el resultado...");
  await sleep(6000);
  await call("GET ?id=", `${base}?id=${id}`);
  await call("GET /{id}", `${base}/${id}`);
  await call("GET ?validation_id=", `${base}?validation_id=${id}`);
  await call("GET (sin parámetros)", base);

  console.log("\n>>> Pega esta salida completa en el chat (no contiene tu clave).");
})();
