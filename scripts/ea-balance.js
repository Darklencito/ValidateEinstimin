// Consulta el saldo de EmailAwesome (GET /api/billing/me). NO imprime la clave.
// No gasta créditos.
//
// Uso:  node scripts/ea-balance.js

try {
  process.loadEnvFile(".env.local");
} catch {
  /* sin .env.local */
}

const key = process.env.EMAILAWESOME_API_KEY;
if (!key) {
  console.error("Falta EMAILAWESOME_API_KEY (ni en el entorno ni en .env.local)");
  process.exit(1);
}

(async () => {
  const res = await fetch("https://api.emailawesome.com/api/billing/me", {
    headers: { Accept: "application/json", "x-api-key": key },
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text.slice(0, 800));
  }
})();
