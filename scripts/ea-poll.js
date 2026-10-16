// Consulta una validación de EmailAwesome hasta que termine y mide cuánto tarda.
// NO imprime la clave. Los GET no gastan créditos.
//
// Uso:
//   node scripts/ea-poll.js                 -> usa el id de la prueba anterior
//   node scripts/ea-poll.js <id> [segundos] -> otro id / otro tiempo máximo (por defecto 180)

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

const id = process.argv[2] || "3f07046c-e251-4c3e-be37-d4490371ee81";
const maxSeconds = Number(process.argv[3]) || 180;
const url = `https://api.emailawesome.com/api/validations/email_validation/${id}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t0 = Date.now();
  console.log(`Consultando ${id} (máx. ${maxSeconds} s)...`);
  let last = "";
  while ((Date.now() - t0) / 1000 < maxSeconds) {
    const res = await fetch(url, { headers: { Accept: "application/json", "x-api-key": key } });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* no JSON */ }
    const secs = Math.round((Date.now() - t0) / 1000);
    const line = j
      ? `status=${j.status} · email_address_status=${j.email_address_status}`
      : `HTTP ${res.status} ${text.slice(0, 200)}`;
    if (line !== last) {
      console.log(`[${String(secs).padStart(3)} s] ${line}`);
      last = line;
    }
    if (j && j.status && !String(j.status).startsWith("PENDING") && j.email_address_status !== "PENDING") {
      console.log(`\nTerminó en ~${secs} s desde que empecé a consultar.`);
      console.log(JSON.stringify(j, null, 2));
      return;
    }
    await sleep(4000);
  }
  console.log(`\nSigue pendiente tras ${maxSeconds} s.`);
})();
