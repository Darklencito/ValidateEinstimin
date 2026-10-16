import net from "net";
import { SocksClient } from "socks";
import { getMx, mapLimit } from "./email-validation";
import type { EmailStatus } from "./validation-types";

// Solo servidor. Capa 3: verificación SMTP por lotes.
//
// Qué hace por cada dominio de destino (p. ej. gmail.com):
//  - Abre UNA conexión SMTP (puerto 25 del servidor de destino) y la reutiliza para todos los
//    correos de ese dominio del lote (RSET entre consultas), con una pausa entre consultas.
//  - Comprueba una sola vez si el dominio es "catch-all" (acepta cualquier dirección).
//  - Opcionalmente sale a través de un proxy SOCKS5 (SMTP_PROXIES) para no usar el puerto 25
//    del hosting. Con varios proxies, cada dominio usa el siguiente (rotación).
// Nunca se envía ningún correo: solo se hace la consulta RCPT TO y se cierra con RSET/QUIT.

// ---------- Configuración (variables de entorno) ----------
export interface ProxyCfg {
  host: string;
  port: number;
  userId?: string;
  password?: string;
  label: string;
}

function parseProxies(raw?: string): ProxyCfg[] {
  if (!raw) return [];
  const out: ProxyCfg[] = [];
  for (const item of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      const u = new URL(item);
      if (!u.protocol.startsWith("socks")) continue;
      out.push({
        host: u.hostname,
        port: Number(u.port) || 1080,
        userId: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
        label: `${u.hostname}:${u.port || 1080}`,
      });
    } catch {
      /* URL inválida: se ignora */
    }
  }
  return out;
}

export function getSmtpConfig() {
  const helo = process.env.SMTP_HELO_DOMAIN || "csv-manager.local";
  return {
    helo,
    mailFrom: process.env.SMTP_MAIL_FROM || `verify@${helo}`,
    // Pausa entre consultas al mismo dominio (ms)
    delayMs: Math.max(0, Number(process.env.SMTP_DELAY_MS ?? 700)),
    // Tope global de consultas por minuto entre TODOS los dominios (0 = sin tope).
    // Útil con proveedores que limitan el puerto 25 (p. ej. Contabo: ~25/min).
    maxPerMinute: Math.max(0, Number(process.env.SMTP_MAX_PER_MINUTE ?? 0)),
    timeoutMs: 10000,
    proxies: parseProxies(process.env.SMTP_PROXIES),
  };
}
type Cfg = ReturnType<typeof getSmtpConfig>;

let proxyCounter = 0;
function nextProxy(cfg: Cfg): ProxyCfg | null {
  if (cfg.proxies.length === 0) return null;
  return cfg.proxies[proxyCounter++ % cfg.proxies.length];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reparte las consultas de todos los dominios a un ritmo máximo de `maxPerMinute`.
// Cada llamada reserva el siguiente hueco libre y espera hasta que llegue.
let nextSlot = 0;
async function rateGate(cfg: { maxPerMinute: number }) {
  if (!cfg.maxPerMinute) return;
  const gap = 60000 / cfg.maxPerMinute;
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await sleep(at - now);
}

// ---------- Conexión y sesión SMTP ----------
async function connect(host: string, proxy: ProxyCfg | null, timeoutMs: number): Promise<net.Socket> {
  if (proxy) {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.userId, password: proxy.password },
      command: "connect",
      destination: { host, port: 25 },
      timeout: timeoutMs,
    });
    return socket;
  }
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port: 25 });
    s.setTimeout(timeoutMs);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
    s.once("timeout", () => {
      s.destroy();
      reject(new Error("timeout"));
    });
  });
}

interface Reply {
  code: number;
  text: string;
}

class SmtpSession {
  private buffer = "";
  private pending: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private replies: Reply[] = []; // respuestas que llegaron antes de pedirlas (p. ej. el saludo 220)
  private dead: Error | null = null;

  constructor(private socket: net.Socket, timeoutMs: number) {
    socket.setTimeout(timeoutMs);
    socket.on("data", (c) => this.onData(c.toString("utf8")));
    socket.on("error", (e) => this.fail(e));
    socket.on("timeout", () => {
      socket.destroy();
      this.fail(new Error("timeout"));
    });
    socket.on("close", () => this.fail(new Error("closed")));
  }

  get alive() {
    return !this.dead;
  }

  private fail(e: Error) {
    if (!this.dead) this.dead = e;
    const p = this.pending;
    this.pending = null;
    p?.reject(e);
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split("\r\n").filter(Boolean);
    const last = lines[lines.length - 1];
    // Respuesta completa: última línea "250 texto" (espacio), no "250-texto" (continúa)
    if (this.buffer.endsWith("\r\n") && last && /^\d{3} /.test(last)) {
      const reply = { code: parseInt(last.slice(0, 3), 10), text: lines.join(" ") };
      this.buffer = "";
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p.resolve(reply);
      } else {
        this.replies.push(reply);
      }
    }
  }

  /** Envía un comando (o solo espera una respuesta si cmd es null) y devuelve la respuesta. */
  send(cmd: string | null): Promise<Reply> {
    if (cmd === null && this.replies.length) return Promise.resolve(this.replies.shift()!);
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      if (cmd !== null) this.socket.write(cmd + "\r\n");
    });
  }

  close() {
    this.socket.destroy();
  }
}

async function openSession(host: string, proxy: ProxyCfg | null, cfg: Cfg): Promise<SmtpSession> {
  const socket = await connect(host, proxy, cfg.timeoutMs);
  const s = new SmtpSession(socket, cfg.timeoutMs);
  try {
    const banner = await s.send(null);
    if (banner.code !== 220) throw new Error(`saludo ${banner.code}`);
    let ehlo = await s.send(`EHLO ${cfg.helo}`);
    if (ehlo.code !== 250) ehlo = await s.send(`HELO ${cfg.helo}`);
    if (ehlo.code !== 250) throw new Error(`EHLO ${ehlo.code}`);
    return s;
  } catch (e) {
    s.close();
    throw e;
  }
}

// ---------- Clasificación de respuestas ----------
// Rechazos que indican bloqueo/política de NUESTRA IP, no que el buzón no exista
const POLICY_REJECT =
  /block|spam|blacklist|blocklist|reputation|policy|denied|\bptr\b|rdns|relay|not permitted|not allowed|rejected due|spamhaus|barracuda|\b5\.7\.\d|\b5\.2\.\d|too many|rate limit|abuse|banned/i;
// Rechazos que indican claramente que el buzón no existe
const NO_MAILBOX =
  /\b5\.1\.[1-6]\b|no such user|unknown user|user unknown|does not exist|doesn't exist|not exist|no mailbox|mailbox (?:not found|unavailable|does not|doesn't)|recipient (?:not found|rejected|unknown|address rejected)|invalid (?:recipient|mailbox|address)|account (?:disabled|inactive|has been disabled)|unrouteable/i;

type Kind = "ok" | "rejected" | "unknown" | "throttled";

function classify(r: Reply): Kind {
  if (r.code === 250 || r.code === 251) return "ok";
  if (r.code >= 500) {
    if (POLICY_REJECT.test(r.text) && !/\b5\.1\.1\b/.test(r.text)) return "unknown";
    return NO_MAILBOX.test(r.text) ? "rejected" : "unknown";
  }
  // 4xx: límite de velocidad, greylisting o fallo temporal
  return "throttled";
}

const short = (t: string) => t.replace(/\s+/g, " ").slice(0, 110);

export interface ProbeResult {
  email: string;
  status: EmailStatus;
  reason: string;
  /** true si el servidor dio una respuesta concluyente (existe / no existe / catch-all) */
  confirmed: boolean;
}

// Caché de catch-all por dominio (entre lotes): evita repetir la prueba
const catchAllCache = new Map<string, { value: boolean; at: number }>();
const CATCHALL_TTL = 6 * 60 * 60 * 1000;

interface DomainOutcome {
  results: ProbeResult[];
  connectFailed: number;
  throttled: number;
}

async function probeDomain(
  domain: string,
  emails: string[],
  cfg: Cfg,
  proxy: ProxyCfg | null,
  stop: { aborted: boolean }
): Promise<DomainOutcome> {
  const results: ProbeResult[] = [];
  let connectFailed = 0;
  let throttled = 0;

  const unknown = (email: string, why: string): ProbeResult => ({
    email, status: "valid", reason: `SMTP no concluyente: ${why}`, confirmed: false,
  });

  const mx = await getMx(domain);
  if (!mx || mx.length === 0) {
    return { results: emails.map((e) => unknown(e, "sin servidor MX consultable")), connectFailed: 0, throttled: 0 };
  }

  let session: SmtpSession | null = null;
  let hostIdx = 0;
  let lastErr = "";

  // Garantiza una sesión viva; prueba hasta 2 servidores MX
  const ensure = async (): Promise<boolean> => {
    if (session?.alive) return true;
    session?.close();
    session = null;
    for (; hostIdx < Math.min(2, mx.length); hostIdx++) {
      try {
        await rateGate(cfg);
        session = await openSession(mx[hostIdx], proxy, cfg);
        return true;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    return false;
  };

  /** MAIL FROM + RCPT TO + RSET sobre la sesión actual. */
  const rcpt = async (addr: string): Promise<Reply> => {
    await rateGate(cfg);
    const m = await session!.send(`MAIL FROM:<${cfg.mailFrom}>`);
    if (m.code !== 250) return m; // el remitente fue rechazado
    const r = await session!.send(`RCPT TO:<${addr}>`);
    await session!.send("RSET").catch(() => {});
    return r;
  };

  try {
    if (!(await ensure())) {
      const why = `no se pudo conectar al puerto 25 de ${domain}${proxy ? ` vía proxy ${proxy.label}` : ""} (${lastErr})`;
      return { results: emails.map((e) => unknown(e, why)), connectFailed: emails.length, throttled: 0 };
    }

    // Prueba de catch-all, una vez por dominio
    let catchAll = catchAllCache.get(domain);
    if (catchAll && Date.now() - catchAll.at > CATCHALL_TTL) catchAll = undefined;
    if (!catchAll) {
      try {
        const fake = `zz-${Math.random().toString(36).slice(2, 12)}@${domain}`;
        const r = await rcpt(fake);
        if (classify(r) === "ok") catchAll = { value: true, at: Date.now() };
        else if (r.code >= 500) catchAll = { value: false, at: Date.now() };
        // 4xx: no concluyente, no se cachea
      } catch {
        /* sesión caída: se reabre abajo */
      }
      if (catchAll) catchAllCache.set(domain, catchAll);
    }
    if (catchAll?.value) {
      return {
        results: emails.map((e) => ({
          email: e, status: "risky_catchall" as const,
          reason: "El dominio acepta cualquier dirección (catch-all): no se puede confirmar el buzón",
          confirmed: true,
        })),
        connectFailed: 0,
        throttled: 0,
      };
    }

    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      if (stop.aborted) break;

      let reply: Reply | null = null;
      for (let attempt = 0; attempt < 2 && !reply; attempt++) {
        if (!(await ensure())) break;
        try {
          reply = await rcpt(email);
        } catch {
          /* conexión caída a mitad: se reintenta con una sesión nueva */
        }
      }

      if (!reply) {
        // Sin conexión: el resto del dominio tampoco se podrá consultar
        const why = `se perdió la conexión con ${domain}`;
        for (let j = i; j < emails.length; j++) results.push(unknown(emails[j], why));
        connectFailed += emails.length - i;
        break;
      }

      const kind = classify(reply);
      if (kind === "ok") {
        results.push({ email, status: "valid", reason: "Buzón confirmado por SMTP", confirmed: true });
      } else if (kind === "rejected") {
        results.push({ email, status: "invalid_mailbox", reason: `El servidor rechazó el buzón: ${short(reply.text)}`, confirmed: true });
      } else if (kind === "throttled") {
        throttled++;
        results.push(unknown(email, `el servidor pidió esperar (${short(reply.text)})`));
      } else {
        results.push(unknown(email, short(reply.text)));
      }

      if (i < emails.length - 1 && cfg.delayMs > 0) await sleep(cfg.delayMs);
    }
  } finally {
    const s = session as SmtpSession | null;
    if (s?.alive) s.send("QUIT").catch(() => {});
    s?.close();
  }

  return { results, connectFailed, throttled };
}

export interface BatchOutcome {
  results: ProbeResult[];
  /** Correos que no se pudieron consultar por falta de conexión (¿puerto 25 bloqueado?) */
  connectFailed: number;
  /** Correos donde el servidor pidió esperar/limitó la velocidad */
  throttled: number;
  via: string;
}

/** Verifica un lote de correos: agrupa por dominio y procesa varios dominios en paralelo. */
export async function verifyBatch(
  emails: string[],
  stop: { aborted: boolean } = { aborted: false }
): Promise<BatchOutcome> {
  const cfg = getSmtpConfig();
  const groups = new Map<string, string[]>();
  for (const e of emails) {
    const d = e.split("@")[1]?.toLowerCase();
    if (!d) continue;
    (groups.get(d) ?? groups.set(d, []).get(d)!).push(e);
  }

  const outcomes = await mapLimit(
    [...groups.entries()],
    4,
    ([domain, list]) => probeDomain(domain, list, cfg, nextProxy(cfg), stop)
  );

  return {
    results: outcomes.flatMap((o) => o.results),
    connectFailed: outcomes.reduce((n, o) => n + o.connectFailed, 0),
    throttled: outcomes.reduce((n, o) => n + o.throttled, 0),
    via: cfg.proxies.length ? `proxy SOCKS5 (${cfg.proxies.length})` : "conexión directa del servidor",
  };
}

export interface ConnectivityResult {
  via: string;
  ok: boolean;
  ms: number;
  message: string;
}

/** Prueba rápida: ¿se puede abrir el puerto 25 de Gmail desde aquí (o desde cada proxy)? */
export async function checkConnectivity(): Promise<ConnectivityResult[]> {
  const cfg = getSmtpConfig();
  const targets: (ProxyCfg | null)[] = cfg.proxies.length ? cfg.proxies : [null];
  const out: ConnectivityResult[] = [];
  for (const p of targets) {
    const t0 = Date.now();
    const via = p ? `proxy ${p.label}` : "conexión directa";
    try {
      const s = await openSession("gmail-smtp-in.l.google.com", p, cfg);
      s.close();
      out.push({ via, ok: true, ms: Date.now() - t0, message: "Puerto 25 accesible: la verificación SMTP puede funcionar." });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      out.push({
        via, ok: false, ms: Date.now() - t0,
        message: p
          ? `El proxy no pudo llegar al puerto 25 de Gmail (${err}). Revisa el proxy o que su proveedor permita el puerto 25.`
          : `No se pudo abrir el puerto 25 (${err}). Probablemente tu hosting lo bloquea: configura un proxy SOCKS5 en SMTP_PROXIES.`,
      });
    }
  }
  return out;
}
