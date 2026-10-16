import { mapLimit } from "./email-validation";
import type { EmailStatus } from "./validation-types";

// Solo servidor. Capa 4: verificación externa con la API de EmailAwesome.
//
// Flujo de su API (sin callback):
//   1) POST  /email_validation        {email}  -> 201 {id, status:"PENDING_BILLING"...}
//   2) GET   /email_validation/{id}   hasta que status deje de ser PENDING* (~15 s)
//   3) email_address_status: VALID | INVALID | CATCH_ALL | UNKNOWN
// Los resultados UNKNOWN no se cobran. La clave va solo en EMAILAWESOME_API_KEY.

// EMAILAWESOME_API_ROOT permite apuntar a un servidor de pruebas; por defecto, la API real.
const root = () => (process.env.EMAILAWESOME_API_ROOT || "https://api.emailawesome.com/api").replace(/\/+$/, "");
const base = () => `${root()}/validations/email_validation`;
const apiKey = () => process.env.EMAILAWESOME_API_KEY || "";

export const eaConfigured = () => apiKey().length > 0;

class EaError extends Error {
  constructor(public httpStatus: number, message: string) {
    super(message);
  }
}

async function ea(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "x-api-key": apiKey(),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new EaError(res.status, text.replace(/\s+/g, " ").slice(0, 160));
  try {
    return JSON.parse(text);
  } catch {
    throw new EaError(res.status, "Respuesta no válida de EmailAwesome");
  }
}

/**
 * Saldo de créditos (GET /billing/me -> {balance}). Devuelve null si no se pudo obtener:
 * es solo informativo y nunca debe bloquear el resto de la app.
 */
export async function getBalance(): Promise<number | null> {
  try {
    const j = (await ea(`${root()}/billing/me`)) as { balance?: unknown };
    return typeof j.balance === "number" && Number.isFinite(j.balance) ? j.balance : null;
  } catch {
    return null;
  }
}

interface EaValidation {
  id: string;
  status?: string;
  email_address_status?: string;
}

const norm = (s?: string) => String(s ?? "").toUpperCase().replace(/[^A-Z]+/g, "_");

/** null si la validación sigue en curso; si no, el estado traducido a los nuestros. */
function interpret(v: EaValidation): { status: EmailStatus; reason: string; confirmed: boolean } | null {
  const job = norm(v.status);
  const verdict = norm(v.email_address_status);
  if (job.startsWith("PENDING") || verdict === "PENDING" || (!job && !verdict)) return null;

  if (verdict === "VALID") {
    return { status: "valid", reason: "Buzón confirmado por EmailAwesome", confirmed: true };
  }
  if (verdict.startsWith("INVALID")) {
    return { status: "invalid_mailbox", reason: "EmailAwesome: el correo no es válido", confirmed: true };
  }
  if (verdict.startsWith("CATCH")) {
    return {
      status: "risky_catchall",
      reason: "EmailAwesome: el dominio acepta cualquier dirección (catch-all)",
      confirmed: true,
    };
  }
  // UNKNOWN (no se cobra) u otro estado no previsto: no se descarta nada
  return {
    status: "valid",
    reason: `EmailAwesome no dio una respuesta definitiva (${verdict || job || "sin estado"})`,
    confirmed: false,
  };
}

export interface EaItem {
  email: string;
  id?: string;
  state: "done" | "pending" | "error";
  status?: EmailStatus;
  reason?: string;
  confirmed?: boolean;
  error?: string;
}

export interface EaBatch {
  items: EaItem[];
  /** Error que obliga a detener todo el proceso (clave inválida, sin créditos, límite) */
  fatal?: string;
}

const FATAL: Record<number, string> = {
  401: "EmailAwesome rechazó la clave de API (401). Revisa EMAILAWESOME_API_KEY.",
  403: "EmailAwesome denegó el acceso (403). Revisa la clave de API y tu plan.",
  402: "EmailAwesome indica que no tienes créditos suficientes (402).",
  429: "EmailAwesome limitó la velocidad (429). Espera unos minutos y continúa.",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Verifica un lote. `resume` contiene validaciones ya creadas (con su id) que solo hay que
 * volver a consultar, para no pagar dos veces por el mismo correo.
 */
export async function verifyWithEa(
  emails: string[],
  resume: { email: string; id: string }[] = [],
  deadlineMs = 45000
): Promise<EaBatch> {
  const started = Date.now();
  let fatal: string | undefined;

  const jobs: { email: string; id?: string }[] = [
    ...resume.map((r) => ({ email: r.email, id: r.id })),
    ...emails.map((email) => ({ email })),
  ];

  const items = await mapLimit(jobs, 8, async (job): Promise<EaItem> => {
    let id = job.id;
    try {
      if (!id) {
        if (fatal) return { email: job.email, state: "error", error: "Omitido por un error anterior" };
        const created = (await ea(base(), { method: "POST", body: JSON.stringify({ email: job.email }) })) as EaValidation;
        id = created.id;
        if (!id) throw new EaError(0, "EmailAwesome no devolvió un id");
      }
      // Consulta cada ~2,5 s hasta que termine o se agote el tiempo del lote
      for (;;) {
        await sleep(2500);
        const v = (await ea(`${base()}/${id}`)) as EaValidation;
        const r = interpret(v);
        if (r) return { email: job.email, id, state: "done", ...r };
        if (Date.now() - started > deadlineMs) return { email: job.email, id, state: "pending" };
      }
    } catch (e) {
      const http = e instanceof EaError ? e.httpStatus : 0;
      const msg = e instanceof Error ? e.message : String(e);
      if (FATAL[http]) {
        fatal = fatal ?? FATAL[http];
        // Si la validación ya se creó, conservamos el id para no perderla
        return { email: job.email, id, state: id ? "pending" : "error", error: FATAL[http] };
      }
      return { email: job.email, id, state: id ? "pending" : "error", error: msg };
    }
  });

  return { items, fatal };
}
