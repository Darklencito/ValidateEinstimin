import type { EaBatch, EaItem } from "./emailawesome";
import type { EmailStatus } from "./validation-types";

// Solo servidor. Capa 4 (alternativa): verificación externa con emailval.net.
//
// API (según su sitio): POST /v1/validate  {emails:[...]} (hasta 500 por llamada, respuesta síncrona)
//   -> {results:[{email, valid_syntax, has_mx, is_disposable, is_catch_all, smtp_result, score, error}]}
// Se cobra por correo ENVIADO (también los inválidos), al final del mes con tarjeta (Stripe).
// Gmail/Outlook/Yahoo/Apple: según su FAQ el puntaje máximo es 60 (no confirman buzón), por eso
// esos dominios NO se envían a este proveedor: se cobrarían sin aportar información.

// EMAILVAL_API_ROOT permite apuntar a un servidor de pruebas; por defecto, la API real.
const root = () => (process.env.EMAILVAL_API_ROOT || "https://api.emailval.net/v1").replace(/\/+$/, "");
const apiKey = () => process.env.EMAILVAL_API_KEY || "";

export const emailvalConfigured = () => apiKey().length > 0;

/** Dominios de los grandes proveedores, donde emailval no puede confirmar el buzón. */
export const EMAILVAL_SKIP_REGEX =
  "^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|aol)\\.[a-z.]+$";

interface EvResult {
  email?: string;
  valid_syntax?: boolean;
  has_mx?: boolean;
  is_disposable?: boolean;
  is_catch_all?: boolean;
  smtp_result?: string | null;
  score?: number;
  error?: string | null;
}

function interpret(x: EvResult): Pick<EaItem, "status" | "reason" | "confirmed"> {
  const smtp = String(x.smtp_result ?? "").toLowerCase();
  const score = typeof x.score === "number" ? x.score : null;
  const tag = `emailval (puntaje ${score ?? "?"}, smtp: ${smtp || "n/d"})`;

  if (x.error) {
    return { status: "valid", reason: `emailval devolvió un error para este correo: ${String(x.error).slice(0, 80)}`, confirmed: false };
  }
  if (x.valid_syntax === false) {
    return { status: "invalid_format", reason: "emailval: formato de correo no válido", confirmed: true };
  }
  if (x.has_mx === false) {
    return { status: "invalid_mx", reason: "emailval: el dominio no tiene servidor de correo (MX)", confirmed: true };
  }
  if (x.is_disposable) {
    return { status: "invalid_disposable", reason: "emailval: correo desechable", confirmed: true };
  }
  if (/reject|invalid|not[_ ]?exist|undeliver|no[_ ]?such|unknown[_ ]?user|mailbox[_ ]?(not|unavail)/.test(smtp)) {
    return { status: "invalid_mailbox", reason: `emailval: el servidor rechazó el buzón (${smtp})`, confirmed: true };
  }
  if (x.is_catch_all) {
    return { status: "risky_catchall", reason: "emailval: el dominio acepta cualquier dirección (catch-all)", confirmed: true };
  }
  if (smtp === "accepted" || (score !== null && score >= 100)) {
    return { status: "valid", reason: "Buzón confirmado por emailval (SMTP)", confirmed: true };
  }
  // Puntaje intermedio (p. ej. 60): el proveedor no pudo confirmar el buzón
  return { status: "valid", reason: `${tag}: no pudo confirmar el buzón`, confirmed: false };
}

const FATAL: Record<number, string> = {
  401: "emailval rechazó la clave de API (401). Revisa EMAILVAL_API_KEY.",
  402: "emailval indica que se agotaron las validaciones gratuitas: hay que suscribirse (402).",
  403: "emailval denegó el acceso (403). Revisa la clave o la suscripción.",
  429: "emailval limitó la velocidad (429). Espera unos minutos y continúa.",
};

export async function verifyWithEmailval(emails: string[]): Promise<EaBatch> {
  const fail = (msg: string, fatal?: string): EaBatch => ({
    items: emails.map((email) => ({ email, state: "error" as const, error: msg })),
    fatal,
  });

  let res: Response;
  try {
    res = await fetch(`${root()}/validate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ emails }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    return fail(`No se pudo contactar con emailval: ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    // Si se acabaron las validaciones gratis, el API lo indica en el cuerpo (el código exacto no está documentado)
    const exhausted = /subscri|free validations|quota|credit|exhaust/i.test(text);
    const msg =
      FATAL[res.status] ??
      (exhausted
        ? "emailval indica que se agotaron las validaciones gratuitas: hay que suscribirse."
        : `emailval respondió ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
    return fail(msg, FATAL[res.status] || exhausted ? msg : undefined);
  }

  let json: { results?: EvResult[] };
  try {
    json = JSON.parse(text);
  } catch {
    return fail("Respuesta no válida de emailval");
  }

  const byEmail = new Map<string, EvResult>();
  (json.results ?? []).forEach((r) => r.email && byEmail.set(r.email.toLowerCase(), r));

  const items: EaItem[] = emails.map((email) => {
    const r = byEmail.get(email.toLowerCase());
    if (!r) return { email, state: "error", error: "emailval no devolvió resultado para este correo" };
    const out = interpret(r);
    return { email, state: "done", status: out.status as EmailStatus, reason: out.reason, confirmed: out.confirmed };
  });
  return { items };
}
