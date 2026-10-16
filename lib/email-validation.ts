import dns from "dns";
import type { EmailResult } from "./validation-types";

// Solo servidor (usa dns y net de Node).

// Regex robusta (basada en RFC 5322 simplificado): local-part sin puntos
// consecutivos ni al inicio/fin, dominio con etiquetas válidas y TLD >= 2.
const EMAIL_REGEX =
  /^(?!\.)(?!.*\.\.)[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}(?<!\.)@(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function isValidFormat(email: string): boolean {
  return email.length <= 254 && EMAIL_REGEX.test(email);
}

// ---------- MX ----------
const mxCache = new Map<string, { p: Promise<string[] | null>; at: number }>();

async function resolveMxOnce(domain: string): Promise<string[] | null> {
  try {
    const r = await dns.promises.resolveMx(domain);
    // "Null MX" (RFC 7505): exchange "." significa que el dominio no recibe correo
    return r
      .filter((m) => m.exchange && m.exchange !== ".")
      .sort((a, b) => a.priority - b.priority)
      .map((m) => m.exchange);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return []; // el dominio no existe / sin MX
    return null; // timeout, SERVFAIL...: error temporal
  }
}

/**
 * Hosts MX ordenados por prioridad, [] si no hay, o null si el DNS falló
 * temporalmente (se reintenta una vez). Cacheado por dominio durante 1 hora;
 * los fallos temporales (null) no se guardan, para no marcar un dominio por un error pasajero.
 */
const MX_TTL = 60 * 60 * 1000;
export function getMx(domain: string): Promise<string[] | null> {
  const hit = mxCache.get(domain);
  if (hit && Date.now() - hit.at < MX_TTL) return hit.p;
  const p = resolveMxOnce(domain).then((r) => (r === null ? resolveMxOnce(domain) : r));
  const entry = { p, at: Date.now() };
  mxCache.set(domain, entry);
  p.then((r) => {
    if (r === null && mxCache.get(domain) === entry) mxCache.delete(domain);
  });
  return p;
}

// ---------- Correos desechables ----------
let disposableSet: Set<string> | null = null;
function getDisposable(): Set<string> {
  if (!disposableSet) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    disposableSet = new Set<string>(require("disposable-email-domains") as string[]);
  }
  return disposableSet;
}

// ---------- Errores de tipeo en dominios populares ----------
const POPULAR_DOMAINS = [
  "gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "yahoo.es", "hotmail.es",
  "outlook.es", "icloud.com", "live.com", "yahoo.com.mx", "hotmail.com.mx", "protonmail.com",
];
// Dominios legítimos parecidos a los populares (evita falsos positivos)
const KNOWN_OK = new Set([
  ...POPULAR_DOMAINS, "mail.com", "email.com", "me.com", "mac.com", "msn.com", "aol.com",
  "ymail.com", "rocketmail.com", "gmx.com", "gmx.net", "gmx.de", "web.de", "zoho.com",
  "pm.me", "proton.me", "hey.com", "fastmail.com", "yandex.com", "mail.ru", "qq.com",
  "163.com", "126.com", "live.com.mx", "outlook.com.mx", "yahoo.com.ar", "yahoo.com.co",
  "hotmail.com.ar", "hotmail.co", "live.co", "gmail.co",
]);

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      // Transposición de letras adyacentes (gmial -> gmail) cuenta como 1 error
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[a.length][b.length];
}

/** Devuelve el dominio popular probablemente intencionado (gmial.com -> gmail.com), o null. */
function suggestDomain(domain: string): string | null {
  if (KNOWN_OK.has(domain)) return null;
  return POPULAR_DOMAINS.find((p) => editDistance(domain, p) === 1) ?? null;
}

// ---------- Cuentas genéricas (role accounts) ----------
const ROLE_ACCOUNTS = new Set([
  "info", "admin", "administrator", "contact", "contacto", "ventas", "sales", "soporte",
  "support", "help", "ayuda", "noreply", "no-reply", "donotreply", "do-not-reply", "postmaster",
  "webmaster", "abuse", "hello", "hola", "office", "oficina", "marketing", "billing",
  "facturacion", "newsletter", "mail", "root", "security", "hostmaster", "mailer-daemon",
  "spam", "privacy", "compras", "rrhh", "empleo",
]);


// ---------- Capas 1 y 2 ----------
//  Capa 1 (local):  formato, lista de exclusión, desechables, errores de tipeo
//  Capa 2 (DNS):    registros MX del dominio + cuentas genéricas
//  Capa 3 (SMTP):   se ejecuta aparte, por lotes y con pausas: ver lib/smtp.ts y /api/smtp-batch
// Cada correo se detiene en la primera capa que lo descarta; `layer` indica hasta cuál llegó.
export async function validateEmail(
  raw: string,
  opts: { excluded?: Set<string> }
): Promise<EmailResult> {
  const email = raw.trim();
  const res = (
    layer: 1 | 2 | 3,
    status: EmailResult["status"],
    reason: string
  ): EmailResult => ({ email: raw, status, reason, layer });

  // ----- Capa 1 -----
  if (!isValidFormat(email)) return res(1, "invalid_format", "Formato de correo no válido");

  const [local, domain] = email.toLowerCase().split("@");

  // Lista de bajas/rebotes exportada de Brevo (u otra plataforma)
  if (opts.excluded?.has(email.toLowerCase())) {
    return res(1, "invalid_excluded", "Está en tu lista de exclusión (bloqueado/rebotado)");
  }
  if (getDisposable().has(domain)) {
    return res(1, "invalid_disposable", `${domain} es un servicio de correo desechable`);
  }
  const suggestion = suggestDomain(domain);
  if (suggestion) return res(1, "risky_typo", `¿Quisiste decir @${suggestion}?`);

  // ----- Capa 2 -----
  const mx = await getMx(domain);
  if (mx && mx.length === 0) {
    return res(2, "invalid_mx", `El dominio ${domain} no tiene registros MX`);
  }
  if (mx === null) {
    // Fallo temporal de DNS: no marcamos como inválido por un error de red
    return res(2, "valid", "Formato correcto (DNS no concluyente)");
  }
  if (ROLE_ACCOUNTS.has(local)) {
    return res(2, "risky_role", `Cuenta genérica (${local}@): alta tasa de rebote/quejas`);
  }
  return res(2, "valid", "Formato, dominio y MX correctos");
}

/**
 * Ejecuta tareas con concurrencia limitada, conservando el orden.
 * `onItem` se llama cada vez que termina un elemento; `signal` permite cancelar.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onItem?: (result: R, index: number) => void,
  signal?: { aborted: boolean }
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length && !signal?.aborted) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
        onItem?.(out[idx], idx);
      }
    })
  );
  return out;
}
