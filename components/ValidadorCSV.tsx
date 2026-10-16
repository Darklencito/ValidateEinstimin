"use client";

import { DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, CheckCircle2, Download, FileUp, Info, Loader2, Play, RefreshCw,
  ShieldAlert, Wifi, XCircle,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { downloadCsv, toCsv } from "@/lib/csv";
import {
  STATUS_LABEL, emptySummary, type EaBatchResponse, type EmailResult, type EmailStatus, type ExtProviderInfo, type SmtpBatchResponse,
  type StreamEvent, type ValidationResponse, type VerifiersStatus,
} from "@/lib/validation-types";
import { ValidationProgressModal, type LiveProgress } from "@/components/ValidationProgressModal";

const BADGE: Record<EmailStatus, string> = {
  valid: "bg-green-100 text-green-700",
  invalid_format: "bg-red-100 text-red-700",
  invalid_mx: "bg-red-100 text-red-700",
  invalid_mailbox: "bg-red-100 text-red-700",
  invalid_disposable: "bg-red-100 text-red-700",
  invalid_excluded: "bg-slate-200 text-slate-700",
  risky_typo: "bg-amber-100 text-amber-700",
  risky_role: "bg-amber-100 text-amber-700",
  risky_catchall: "bg-amber-100 text-amber-700",
};

type StreamMeta = Omit<ValidationResponse, "results" | "summary" | "total">;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/**
 * Con "un correo por celda" activo, de cada celda con varios correos solo se conserva
 * el primero válido (o el primero si ninguno lo es).
 */
function pickOnePerCell(results: EmailResult[], enabled: boolean): EmailResult[] {
  if (!enabled) return results;
  const keeper = new Map<number, number>(); // grupo -> índice conservado
  results.forEach((r, i) => {
    if (r.group === undefined) return;
    const cur = keeper.get(r.group);
    if (cur === undefined || (r.status === "valid" && results[cur].status !== "valid")) {
      keeper.set(r.group, i);
    }
  });
  return results.filter((r, i) => r.group === undefined || keeper.get(r.group) === i);
}

function tally(results: EmailResult[]) {
  let valid = 0, invalid = 0, risky = 0;
  for (const r of results) {
    if (r.status === "valid") valid++;
    else if (r.status.startsWith("risky_")) risky++;
    else invalid++;
  }
  return { valid, invalid, risky };
}

interface Connectivity { via: string; ok: boolean; ms: number; message: string }

export default function ValidadorCSV() {
  const inputRef = useRef<HTMLInputElement>(null);
  const excludeRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [data, setData] = useState<ValidationResponse | null>(null);
  const [progress, setProgress] = useState<LiveProgress | null>(null);
  const [excludeFile, setExcludeFile] = useState<File | null>(null);

  // Capa 3 (SMTP) por lotes
  const [smtp, setSmtp] = useState(false);
  const [batchSize, setBatchSize] = useState(40);
  const [pauseSec, setPauseSec] = useState(10);
  const [checking, setChecking] = useState(false);
  const [connectivity, setConnectivity] = useState<Connectivity[] | null>(null);

  // Opciones de salida
  const [onePerCell, setOnePerCell] = useState(true);
  const [strictSmtp, setStrictSmtp] = useState(false);

  // Capa 4: verificación externa (EmailAwesome / emailval), opcional y con costo
  const [verifiers, setVerifiers] = useState<VerifiersStatus | null>(null);
  const [extMode, setExtMode] = useState<string>("auto"); // "auto" o el id de un proveedor
  const [eaMax, setEaMax] = useState(500);
  /** Consulta qué proveedores hay configurados y su saldo. */
  const refreshEa = () =>
    fetch("/api/ea-status")
      .then((r) => r.json())
      .then((j: VerifiersStatus) => setVerifiers(j))
      .catch(() => setVerifiers({ order: [], providers: [] }));
  useEffect(() => {
    refreshEa();
  }, []);

  // Proveedores que se usarían según el modo elegido, en orden
  const extProviders = useMemo<ExtProviderInfo[]>(() => {
    if (!verifiers) return [];
    const configured = verifiers.providers.filter((p) => p.configured);
    if (extMode === "auto") {
      return verifiers.order
        .map((id) => configured.find((p) => p.id === id))
        .filter((p): p is ExtProviderInfo => !!p);
    }
    return configured.filter((p) => p.id === extMode);
  }, [verifiers, extMode]);

  // ---------- Prueba de conexión al puerto 25 ----------
  async function testConnection() {
    setChecking(true);
    setConnectivity(null);
    try {
      const res = await fetch("/api/smtp-check");
      const json = await res.json();
      setConnectivity(json.results ?? []);
    } catch {
      setConnectivity([{ via: "—", ok: false, ms: 0, message: "No se pudo ejecutar la prueba." }]);
    } finally {
      setChecking(false);
    }
  }

  // ---------- Capa 3: SMTP por lotes, con pausas y reintento ----------
  /** Verifica por SMTP los correos pendientes de `base`. Nunca lanza por cancelación: conserva lo avanzado. */
  async function runSmtp(base: ValidationResponse, controller: AbortController, retryInconclusive = false) {
    const results = base.results.map((r) => ({ ...r }));
    const index = new Map<string, number>();
    results.forEach((r, i) => index.set(r.email.toLowerCase(), i));

    const candidates = pickOnePerCell(results, onePerCell)
      .filter((r) =>
        r.status === "valid" &&
        (r.layer === 2 || (retryInconclusive && r.layer === 3 && !r.confirmed))
      )
      .map((r) => r.email);

    const size = Math.min(Math.max(batchSize, 5), 200);
    const basePause = Math.max(pauseSec, 0) * 1000;
    let pause = basePause;
    const batches = Math.ceil(candidates.length / size);
    const recent: EmailResult[] = [];
    const layerCounts: [number, number, number, number] = [0, 0, 0, 0];
    let done = 0;
    let stopReason = "";

    const show = (statusText: string) =>
      setProgress({
        done, total: candidates.length, phase: "smtp", statusText,
        recent: recent.slice(0, 40), layerCounts: [...layerCounts], ...tally(pickOnePerCell(results, onePerCell)),
      });
    show("Preparando la verificación SMTP...");

    for (let b = 0; b < batches && !controller.signal.aborted; b++) {
      const slice = candidates.slice(b * size, (b + 1) * size);
      show(`Lote ${b + 1} de ${batches} · consultando ${slice.length} correos...`);

      let res: SmtpBatchResponse;
      try {
        const r = await fetch("/api/smtp-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emails: slice }),
          signal: controller.signal,
        });
        if (r.status === 401) {
          window.location.href = "/login";
          return;
        }
        const json = await r.json().catch(() => ({}));
        if (!r.ok) {
          stopReason = json.error ?? "Error del servidor en la verificación SMTP.";
          break;
        }
        res = json as SmtpBatchResponse;
      } catch (e) {
        if (!isAbort(e)) stopReason = "Se perdió la conexión con el servidor durante la verificación SMTP.";
        break;
      }

      // Si NINGÚN correo del lote se pudo consultar, el puerto 25 está bloqueado: no seguimos gastando tiempo
      if (res.connectFailed >= slice.length) {
        stopReason =
          `No se pudo conectar al puerto 25 (${res.via}). Usa «Probar conexión SMTP» y, si tu hosting lo bloquea, ` +
          `configura un proxy SOCKS5 (variable SMTP_PROXIES).`;
        break;
      }

      for (const r of res.results) {
        const i = index.get(r.email.toLowerCase());
        if (i === undefined) continue;
        results[i] = { ...results[i], status: r.status, reason: r.reason, confirmed: r.confirmed, layer: 3 };
        recent.unshift(results[i]);
      }
      if (recent.length > 40) recent.length = 40;
      done += slice.length;
      layerCounts[2] += res.results.length;

      // Si el servidor pide esperar, pausamos más; si todo va bien, volvemos a la pausa normal
      pause = res.throttled > 0 ? Math.min(Math.max(pause, 5000) * 2, 300000) : Math.max(basePause, pause / 2);

      if (b < batches - 1) {
        for (let left = Math.round(pause / 1000); left > 0 && !controller.signal.aborted; left--) {
          show(
            `Lote ${b + 1} de ${batches} listo · pausa de ${left} s antes del siguiente` +
              (res.throttled > 0 ? " (el servidor pidió esperar, aumentamos la pausa)" : "")
          );
          await sleep(1000);
        }
      }
    }

    if (controller.signal.aborted && !stopReason) {
      stopReason = "Verificación SMTP detenida. Puedes continuar donde quedó con el botón «Continuar verificación SMTP».";
    }
    const summary = emptySummary();
    results.forEach((r) => summary[r.status]++);
    setData({
      ...base, results, summary,
      notice: stopReason || (candidates.length === 0 ? "No había correos pendientes de verificar por SMTP." : undefined),
    });
  }

  // ---------- Capa 4: verificación externa (usa créditos o dinero) ----------
  /**
   * Envía a los proveedores externos (en el orden indicado) los correos que siguen sin confirmar.
   * Si un proveedor se queda sin créditos o falla, continúa con el siguiente. Un correo ya enviado
   * en esta ejecución no se reenvía a otro proveedor, para no cobrarlo dos veces.
   */
  async function runExternal(
    base: ValidationResponse,
    controller: AbortController,
    providers: ExtProviderInfo[],
    maxSend: number
  ) {
    const results = base.results.map((r) => ({ ...r }));
    const index = new Map<string, number>();
    results.forEach((r, i) => index.set(r.email.toLowerCase(), i));

    const sent = new Set<string>(); // correos ya enviados a algún proveedor en esta ejecución
    const notes: string[] = [];
    const recent: EmailResult[] = [];
    const layerCounts: [number, number, number, number] = [0, 0, 0, 0];
    let done = 0;
    let budget = Math.max(maxSend, 0); // correos que aún se pueden enviar en total
    const total = budget;
    let unfinished = 0;

    const show = (statusText: string) =>
      setProgress({
        done, total, phase: "ea", statusText,
        recent: recent.slice(0, 40), layerCounts: [...layerCounts],
        ...tally(pickOnePerCell(results, onePerCell)),
      });

    for (let pi = 0; pi < providers.length; pi++) {
      const p = providers[pi];
      if (controller.signal.aborted || budget <= 0) break;

      // Correos aún sin confirmar y que este proveedor puede aportar algo
      const skip = p.skipDomainRegex ? new RegExp(p.skipDomainRegex, "i") : null;
      let skipped = 0;
      let list = pickOnePerCell(results, onePerCell)
        .filter((r) => r.status === "valid" && !r.confirmed && !sent.has(r.email.toLowerCase()))
        .map((r) => r.email)
        .filter((e) => {
          if (skip && skip.test(e.split("@")[1] ?? "")) {
            skipped++;
            return false;
          }
          return true;
        });
      if (p.balance !== null) list = list.slice(0, Math.max(p.balance, 0)); // no pasar del saldo
      list = list.slice(0, budget);
      if (skipped > 0) {
        notes.push(`${skipped} correos de Gmail/Outlook/Yahoo/Apple no se enviaron a ${p.name} porque no puede confirmarlos.`);
      }
      if (list.length === 0) continue;

      const pending = new Map<string, string>(); // correo -> id de validación sin terminar
      let stopped = "";

      /** Envía un lote y aplica lo que haya terminado. Devuelve false si hay que parar con este proveedor. */
      const send = async (emails: string[], resume: { email: string; id: string }[]): Promise<boolean> => {
        let res: EaBatchResponse;
        try {
          const r = await fetch("/api/ea-batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: p.id, emails, resume }),
            signal: controller.signal,
          });
          if (r.status === 401) {
            window.location.href = "/login";
            return false;
          }
          const json = await r.json().catch(() => ({}));
          if (!r.ok) {
            stopped = json.error ?? `Error del servidor al consultar ${p.name}.`;
            return false;
          }
          res = json as EaBatchResponse;
        } catch (e) {
          if (!isAbort(e)) stopped = `Se perdió la conexión con el servidor durante la verificación con ${p.name}.`;
          return false;
        }

        for (const it of res.items) {
          const i = index.get(it.email.toLowerCase());
          if (it.state === "done" && it.status && i !== undefined) {
            results[i] = { ...results[i], status: it.status, reason: it.reason ?? "", confirmed: !!it.confirmed, layer: 4 };
            pending.delete(it.email);
            recent.unshift(results[i]);
            layerCounts[3]++;
            done++;
          } else if (it.id) {
            pending.set(it.email, it.id); // creada pero sin terminar: se reanuda después
          }
        }
        if (recent.length > 40) recent.length = 40;
        if (res.fatal) {
          stopped = res.fatal;
          return false;
        }
        return true;
      };

      const size = p.maxBatch;
      const nBatches = Math.ceil(list.length / size);
      for (let b = 0; b < nBatches && !controller.signal.aborted; b++) {
        const slice = list.slice(b * size, (b + 1) * size);
        slice.forEach((e) => sent.add(e.toLowerCase()));
        budget -= slice.length;
        show(`${p.name}: lote ${b + 1} de ${nBatches} · esperando respuesta de ${slice.length} correos...`);
        if (!(await send(slice, []))) break;
      }

      // Reanudar (hasta 3 rondas) las validaciones que no terminaron a tiempo (solo EmailAwesome las crea así)
      for (let round = 1; round <= 3 && pending.size > 0 && !stopped && !controller.signal.aborted; round++) {
        const rl = [...pending.entries()].map(([email, id]) => ({ email, id }));
        for (let k = 0; k < rl.length && !controller.signal.aborted; k += size) {
          show(`${p.name}: reanudando ${rl.length} validaciones pendientes (ronda ${round})...`);
          if (!(await send([], rl.slice(k, k + size)))) break;
        }
      }
      unfinished += pending.size;

      if (stopped) {
        const next = providers[pi + 1];
        notes.push(`${p.name}: ${stopped}${next && !controller.signal.aborted ? ` Se continúa con ${next.name}.` : ""}`);
      }
    }

    if (controller.signal.aborted) {
      notes.push("Verificación externa detenida. Lo ya verificado se conserva.");
    }
    if (unfinished > 0) {
      notes.push(`${unfinished} validaciones no terminaron a tiempo; siguen como «no concluyentes».`);
    }
    const summary = emptySummary();
    results.forEach((r) => summary[r.status]++);
    setData({
      ...base, results, summary,
      notice: notes.length ? notes.join(" ") : total === 0 ? "No había correos sin confirmar para enviar." : undefined,
    });
  }

  /** Lanza la capa 4 sobre los resultados actuales, tras confirmar el gasto. */
  async function startEa() {
    if (!data || eaN <= 0 || extProviders.length === 0) return;
    const lines = extProviders
      .map((p) => {
        const detail =
          p.balance !== null
            ? ` (${p.balance.toLocaleString()} créditos disponibles)`
            : p.costPerEmail !== null
              ? ` (≈ US$ ${p.costPerEmail} por correo; ≈ US$ ${(eaN * p.costPerEmail).toFixed(2)} si se enviaran todos; se cobra a fin de mes)`
              : "";
        return `• ${p.name}${detail}`;
      })
      .join("\n");
    const ok = window.confirm(
      `Se enviarán hasta ${eaN.toLocaleString()} correos sin confirmar a:\n${lines}\n\n` +
        (extProviders.length > 1 ? "Si el primero se queda sin créditos, se continuará con el siguiente.\n\n" : "") +
        `Esto tiene costo (créditos de tu plan o cargo a tu tarjeta). ¿Continuar?`
    );
    if (!ok) return;
    setError("");
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runExternal(data, controller, extProviders, eaN);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error durante la verificación externa");
    } finally {
      refreshEa(); // actualiza los saldos mostrados
      abortRef.current = null;
      setProgress(null);
      setLoading(false);
    }
  }

  // ---------- Capas 1 y 2 (stream) y, si se pidió, capa 3 ----------
  async function handleFile(file: File) {
    setError("");
    setData(null);
    if (!/\.csv$/i.test(file.name)) {
      setError("El archivo debe tener extensión .csv");
      return;
    }
    setFileName(file.name);
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({
      done: 0, total: 0, phase: "layers12", recent: [], layerCounts: [0, 0, 0, 0],
      valid: 0, invalid: 0, risky: 0,
    });

    try {
      const fd = new FormData();
      fd.append("file", file);
      if (excludeFile) fd.append("exclude", excludeFile);
      const res = await fetch("/api/validate-csv", { method: "POST", body: fd, signal: controller.signal });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Error al validar el archivo");
      }

      // Lee el stream NDJSON: una línea JSON por evento
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const all: EmailResult[] = [];
      const recent: EmailResult[] = [];
      const layerCounts: [number, number, number, number] = [0, 0, 0, 0];
      let total = 0, done = 0, valid = 0, invalid = 0, risky = 0;
      let meta: StreamMeta | null = null;
      let buffer = "";
      let lastFlush = 0;

      // Actualiza la UI como máximo cada 100 ms para no saturar React con listas grandes
      const flush = (force = false) => {
        const now = Date.now();
        if (!force && now - lastFlush < 100) return;
        lastFlush = now;
        setProgress({
          done, total, phase: "layers12", recent: recent.slice(0, 40),
          layerCounts: [...layerCounts], valid, invalid, risky,
        });
      };

      const handle = (ev: StreamEvent) => {
        if (ev.type === "start") {
          total = ev.total;
        } else if (ev.type === "item") {
          all[ev.index] = ev.result;
          done++;
          const s = ev.result.status;
          if (s === "valid") valid++;
          else if (s.startsWith("risky_")) risky++;
          else invalid++;
          if (ev.result.layer) layerCounts[ev.result.layer - 1]++;
          recent.unshift(ev.result);
          if (recent.length > 40) recent.pop();
        } else {
          meta = ev.meta;
        }
        flush();
      };

      for (;;) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) handle(JSON.parse(line));
      }
      if (buffer.trim()) handle(JSON.parse(buffer));
      flush(true);

      if (!meta) throw new Error("La conexión se interrumpió antes de terminar. Inténtalo de nuevo.");
      const results = all.filter(Boolean);
      const summary = emptySummary();
      results.forEach((r) => summary[r.status]++);
      const base: ValidationResponse = { total: results.length, summary, results, ...(meta as StreamMeta) };
      setData(base);

      // Capa 3 (opcional), por lotes
      if (smtp) await runSmtp(base, controller);
    } catch (e) {
      setError(isAbort(e) ? "Validación cancelada." : e instanceof Error ? e.message : "Error de conexión");
    } finally {
      abortRef.current = null;
      setProgress(null);
      setLoading(false);
    }
  }

  /** Continúa (o reintenta) la verificación SMTP sobre los resultados ya obtenidos. */
  async function continueSmtp(retryInconclusive: boolean) {
    if (!data) return;
    setError("");
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runSmtp(data, controller, retryInconclusive);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error durante la verificación SMTP");
    } finally {
      abortRef.current = null;
      setProgress(null);
      setLoading(false);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f && !loading) handleFile(f);
  }

  // ---------- Resultados que se muestran y descargan ----------
  const view = useMemo(() => {
    if (!data) return { results: [] as EmailResult[], summary: emptySummary(), total: 0, discarded: 0, pending: 0, inconclusive: 0, unconfirmed: 0, hasSmtp: false };
    const results = pickOnePerCell(data.results, onePerCell);
    const summary = emptySummary();
    results.forEach((r) => summary[r.status]++);
    return {
      results, summary, total: results.length, discarded: data.results.length - results.length,
      pending: results.filter((r) => r.status === "valid" && r.layer === 2).length,
      inconclusive: results.filter((r) => r.status === "valid" && r.layer === 3 && !r.confirmed).length,
      unconfirmed: results.filter((r) => r.status === "valid" && !r.confirmed).length,
      hasSmtp: results.some((r) => r.layer === 3),
    };
  }, [data, onePerCell]);

  const invalid =
    view.summary.invalid_format + view.summary.invalid_mx + view.summary.invalid_mailbox +
    view.summary.invalid_disposable + view.summary.invalid_excluded;
  const risky = view.summary.risky_typo + view.summary.risky_role + view.summary.risky_catchall;
  // Cuántos correos se enviarían: sin confirmar, hasta el máximo elegido y hasta el saldo de los proveedores elegidos
  const extCapacity = extProviders.reduce((s, p) => s + (p.balance ?? Infinity), 0);
  const eaN = Math.max(0, Math.min(view.unconfirmed, Math.max(eaMax, 0), extCapacity));

  function downloadClean() {
    const rows = view.results
      .filter((r) => r.status === "valid" && (!strictSmtp || r.confirmed))
      .map((r) => ({ correo: r.email }));
    downloadCsv("correos_validos.csv", toCsv(rows, ["correo"]));
  }

  function downloadFull() {
    const rows = view.results.map((r) => ({
      correo: r.email, estado: STATUS_LABEL[r.status], motivo: r.reason,
      capa: r.layer ? String(r.layer) : "", confirmado_smtp: r.confirmed ? "si" : "no",
      celda_original: r.source ?? "",
    }));
    downloadCsv(
      "resultado_completo.csv",
      toCsv(rows, ["correo", "estado", "motivo", "capa", "confirmado_smtp", "celda_original"])
    );
  }

  const cleanCount = view.results.filter((r) => r.status === "valid" && (!strictSmtp || r.confirmed)).length;

  return (
    <div className="space-y-6">
      {progress && (
        <ValidationProgressModal
          progress={progress}
          fileName={fileName}
          onCancel={() => abortRef.current?.abort()}
        />
      )}

      <div>
        <h1 className="text-2xl font-semibold">Validador de correos</h1>
        <p className="text-sm text-slate-500">
          Sube un CSV con una columna de correos. Pasa por 3 capas: sintaxis y listas, dominio (MX) y,
          opcionalmente, verificación SMTP del buzón.
        </p>
      </div>

      <Card className="space-y-4">
        {/* Capa 3: SMTP */}
        <div className="rounded-lg border border-slate-200 p-3 text-sm">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={smtp}
              onChange={(e) => setSmtp(e.target.checked)}
              disabled={loading}
              className="mt-0.5"
            />
            <span>
              <strong>Capa 3: verificación SMTP por lotes (opcional)</strong>
              <span className="block text-slate-500">
                Confirma si el buzón existe. Solo se consultan los correos que pasaron las capas 1 y 2,
                en lotes pequeños con pausas para no saturar al servidor ni bloquear tu hosting. Es lenta:
                una lista de miles puede tardar horas (mantén esta pestaña abierta).
              </span>
            </span>
          </label>

          {smtp && (
            <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
              <div className="flex flex-wrap items-end gap-4">
                <label className="text-xs text-slate-600">
                  Correos por lote
                  <select
                    className="mt-1 block rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
                    value={batchSize}
                    onChange={(e) => setBatchSize(Number(e.target.value))}
                    disabled={loading}
                  >
                    {[20, 40, 80, 120].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <label className="text-xs text-slate-600">
                  Pausa entre lotes
                  <select
                    className="mt-1 block rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
                    value={pauseSec}
                    onChange={(e) => setPauseSec(Number(e.target.value))}
                    disabled={loading}
                  >
                    {[5, 10, 20, 30, 60].map((n) => <option key={n} value={n}>{n} s</option>)}
                  </select>
                </label>
                <Button variant="secondary" onClick={testConnection} disabled={checking || loading}>
                  {checking ? <Loader2 size={16} className="animate-spin" /> : <Wifi size={16} />}
                  Probar conexión SMTP
                </Button>
              </div>

              {connectivity && (
                <ul className="space-y-1 text-xs">
                  {connectivity.map((c, i) => (
                    <li
                      key={i}
                      className={`flex items-start gap-1.5 rounded-lg p-2 ${
                        c.ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"
                      }`}
                    >
                      {c.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <XCircle size={14} className="mt-0.5 shrink-0" />}
                      <span><strong>{c.via}</strong> · {c.ms} ms · {c.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Lista de exclusión */}
        <div className="rounded-lg border border-slate-200 p-3 text-sm">
          <p className="font-medium">Lista de exclusión (opcional, recomendado para Brevo)</p>
          <p className="mb-2 text-slate-500">
            Sube un CSV exportado de Brevo con tus contactos bloqueados, rebotados (hard bounce)
            o dados de baja. Esos correos se descartarán. Selecciónalo <strong>antes</strong> de
            subir tu archivo principal.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={loading}
              onClick={() => excludeRef.current?.click()}
            >
              <FileUp size={16} /> {excludeFile ? "Cambiar lista" : "Seleccionar lista"}
            </Button>
            {excludeFile && (
              <span className="flex items-center gap-1 text-slate-600">
                {excludeFile.name}
                <button
                  type="button"
                  className="text-red-600 hover:underline"
                  onClick={() => setExcludeFile(null)}
                >
                  quitar
                </button>
              </span>
            )}
            <input
              ref={excludeRef}
              type="file"
              accept=".csv,.txt,text/csv"
              hidden
              onChange={(e) => {
                setExcludeFile(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => !loading && inputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition ${
            dragging ? "border-indigo-500 bg-indigo-50" : "border-slate-300 hover:bg-slate-50"
          }`}
        >
          {loading ? (
            <>
              <Loader2 className="animate-spin text-indigo-600" size={36} />
              <p className="text-sm font-medium">Procesando {fileName}...</p>
            </>
          ) : (
            <>
              <FileUp className="text-indigo-600" size={36} />
              <p className="text-sm font-medium">Arrastra tu CSV aquí o haz clic para seleccionarlo</p>
              <p className="text-xs text-slate-500">Máx. 5 MB · 10.000 correos</p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = ""; // permite volver a subir el mismo archivo
            }}
          />
        </div>

        {error && (
          <div role="alert" className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle size={16} /> {error}
          </div>
        )}
      </Card>

      {data && (
        <>
          {data.notice && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              <Info size={16} className="mt-0.5 shrink-0" /> {data.notice}
            </div>
          )}

          {/* Continuar / reintentar SMTP */}
          {(view.pending > 0 && view.hasSmtp) || view.inconclusive > 0 ? (
            <Card className="flex flex-wrap items-center gap-3 border-indigo-200 bg-indigo-50 text-sm">
              <span className="flex-1">
                {view.pending > 0 && view.hasSmtp && <>Quedan <strong>{view.pending}</strong> correos sin verificar por SMTP. </>}
                {view.inconclusive > 0 && <><strong>{view.inconclusive}</strong> quedaron «no concluyentes» (el servidor no dio una respuesta clara). </>}
              </span>
              {view.pending > 0 && view.hasSmtp && (
                <Button onClick={() => continueSmtp(false)} disabled={loading}>
                  <Play size={16} /> Continuar verificación SMTP
                </Button>
              )}
              {view.inconclusive > 0 && (
                <Button variant="secondary" onClick={() => continueSmtp(true)} disabled={loading}>
                  <RefreshCw size={16} /> Reintentar no concluyentes
                </Button>
              )}
            </Card>
          ) : null}

          {/* Capa 4: verificación externa (opcional, con costo) */}
          {view.unconfirmed > 0 && (
            <Card className="space-y-3 border-slate-200 text-sm">
              <div>
                <p className="font-medium">Capa 4: verificación externa (opcional)</p>
                <p className="text-slate-500">
                  Hay <strong>{view.unconfirmed.toLocaleString()}</strong> correos válidos que ningún servidor confirmó
                  (no concluyentes o sin SMTP). Un proveedor externo puede confirmarlos, pero <strong>tiene costo</strong>.
                  Nunca se envía nada sin que lo confirmes.
                </p>
              </div>

              {verifiers && verifiers.providers.every((p) => !p.configured) ? (
                <p className="rounded-lg bg-amber-50 p-2 text-amber-800">
                  Configura al menos una clave en el servidor: <code>EMAILAWESOME_API_KEY</code> o{" "}
                  <code>EMAILVAL_API_KEY</code>.
                </p>
              ) : (
                <>
                  <div className="space-y-2">
                    <label className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="extMode"
                        className="mt-1"
                        checked={extMode === "auto"}
                        onChange={() => setExtMode("auto")}
                        disabled={loading}
                      />
                      <span>
                        <strong>Automático</strong>: usa los proveedores en este orden y, si uno se queda sin
                        créditos o falla, continúa con el siguiente
                        {verifiers && (
                          <span className="text-slate-500">
                            {" "}
                            ({verifiers.order
                              .map((id) => verifiers.providers.find((p) => p.id === id))
                              .filter((p) => p?.configured)
                              .map((p) => p!.name)
                              .join(" → ") || "—"})
                          </span>
                        )}
                        .
                      </span>
                    </label>

                    {verifiers?.providers.map((p) => (
                      <label key={p.id} className={`flex items-start gap-2 ${p.configured ? "" : "opacity-50"}`}>
                        <input
                          type="radio"
                          name="extMode"
                          className="mt-1"
                          checked={extMode === p.id}
                          onChange={() => setExtMode(p.id)}
                          disabled={loading || !p.configured}
                        />
                        <span>
                          <strong>{p.name}</strong>
                          {!p.configured && " (sin clave configurada)"}
                          {p.balance !== null && (
                            <>
                              {" "}· créditos: <strong className={p.balance <= 0 ? "text-red-600" : ""}>{p.balance.toLocaleString()}</strong>
                            </>
                          )}
                          {p.costPerEmail !== null && (
                            <> · ≈ US$ {p.costPerEmail} por correo enviado (también los inválidos), cobrado a fin de mes</>
                          )}
                          {p.skipDomainRegex && (
                            <span className="block text-xs text-amber-700">
                              No se le envían Gmail/Outlook/Yahoo/Apple: según el propio proveedor no puede confirmar esos
                              buzones (puntaje máximo 60), y se cobrarían igual.
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-end gap-3">
                    <label className="text-xs text-slate-600">
                      Máximo de correos a enviar
                      <input
                        type="number"
                        min={1}
                        max={view.unconfirmed}
                        value={eaMax}
                        onChange={(e) => setEaMax(Number(e.target.value))}
                        disabled={loading}
                        className="mt-1 block w-32 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
                      />
                    </label>
                    <Button onClick={startEa} disabled={loading || verifiers === null || eaN <= 0}>
                      <Play size={16} /> Verificar {eaN.toLocaleString()} correos
                    </Button>
                    {extProviders.length === 1 && extProviders[0].costPerEmail !== null && eaN > 0 && (
                      <span className="text-slate-600">
                        Costo máximo estimado: <strong>US$ {(eaN * extProviders[0].costPerEmail).toFixed(2)}</strong>
                      </span>
                    )}
                  </div>
                </>
              )}
            </Card>
          )}

          {!view.hasSmtp && view.pending > 0 && (
            <div className="flex items-start gap-2 rounded-lg bg-slate-100 p-3 text-sm text-slate-700">
              <Info size={16} className="mt-0.5 shrink-0" />
              <span>
                <strong>{view.pending}</strong> correos pasaron las capas 1 y 2. Si activas la capa 3 (SMTP) antes
                de subir el archivo, también se comprobará que el buzón exista.
              </span>
            </div>
          )}

          {data.multiCells > 0 && (
            <Card className="border-indigo-200 bg-indigo-50">
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={onePerCell}
                  onChange={(e) => setOnePerCell(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <strong>Unir: dejar solo 1 correo por celda</strong>
                  <span className="block text-slate-600">
                    Se detectaron {data.multiCells} celda(s) con varios correos (por ejemplo
                    «aaa@aa.com / aaab@aa.com»). Se conserva el primer correo válido de cada una
                    {onePerCell ? ` y se descartan ${view.discarded} correo(s) sobrantes` : ""}.
                    Desmárcalo para conservar todos.
                  </span>
                </span>
              </label>
            </Card>
          )}

          {data.excludedListSize > 0 && (
            <div className="flex items-center gap-2 rounded-lg bg-indigo-50 p-3 text-sm text-indigo-800">
              <Info size={16} /> Se usó tu lista de exclusión ({data.excludedListSize} correos).
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat icon={<CheckCircle2 />} label="Válidos (seguros para enviar)" value={view.summary.valid} color="text-green-600" />
            <Stat icon={<XCircle />} label="Inválidos / excluidos" value={invalid} color="text-red-600"
              hint={`Formato ${view.summary.invalid_format} · MX ${view.summary.invalid_mx} · Buzón ${view.summary.invalid_mailbox} · Desechables ${view.summary.invalid_disposable} · Lista ${view.summary.invalid_excluded}`} />
            <Stat icon={<ShieldAlert />} label="Riesgo (no incluidos)" value={risky} color="text-amber-600"
              hint={`Tipeo ${view.summary.risky_typo} · Genéricas ${view.summary.risky_role} · Catch-all ${view.summary.risky_catchall}`} />
            <Stat icon={<FileUp />} label="Total únicos" value={view.total} color="text-slate-700" />
          </div>

          <Card className="space-y-4">
            {view.hasSmtp && (
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={strictSmtp}
                  onChange={(e) => setStrictSmtp(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <strong>CSV limpio estricto: solo buzones confirmados (SMTP o EmailAwesome)</strong>
                  <span className="block text-slate-500">
                    Si lo desmarcas, el CSV limpio también incluye los válidos «no concluyentes» (pasaron las
                    capas 1 y 2 pero el servidor no confirmó el buzón).
                  </span>
                </span>
              </label>
            )}

            <div className="flex flex-wrap gap-2">
              <Button onClick={downloadClean} disabled={cleanCount === 0}>
                <Download size={16} /> CSV limpio ({cleanCount.toLocaleString()})
              </Button>
              <Button variant="secondary" onClick={downloadFull}>
                <Download size={16} /> CSV completo
              </Button>
            </div>

            <div className="max-h-[28rem] overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-slate-100 text-xs uppercase text-slate-600">
                  <tr>
                    <th className="px-3 py-2">Correo</th>
                    <th className="px-3 py-2">Estado</th>
                    <th className="px-3 py-2">Motivo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {view.results.map((r, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 break-all">{r.email}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[r.status]}`}>
                          {STATUS_LABEL[r.status]}
                        </span>
                        {r.confirmed && (
                          <span className="ml-1 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
                            {r.layer === 4 ? "EmailAwesome ✓" : "SMTP ✓"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({
  icon, label, value, color, hint,
}: { icon: React.ReactNode; label: string; value: number; color: string; hint?: string }) {
  return (
    <Card className="flex items-start gap-3">
      <div className={color}>{icon}</div>
      <div>
        <p className="text-2xl font-semibold">{value}</p>
        <p className="text-sm text-slate-500">{label}</p>
        {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
      </div>
    </Card>
  );
}
