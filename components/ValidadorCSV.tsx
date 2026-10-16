"use client";

import { DragEvent, useMemo, useRef, useState } from "react";
import {
  AlertCircle, CheckCircle2, Download, FileUp, Info, Loader2, Play, RefreshCw,
  ShieldAlert, Wifi, XCircle,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { downloadCsv, toCsv } from "@/lib/csv";
import {
  STATUS_LABEL, emptySummary, type EmailResult, type EmailStatus, type SmtpBatchResponse,
  type StreamEvent, type ValidationResponse,
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
    const layerCounts: [number, number, number] = [0, 0, 0];
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
      done: 0, total: 0, phase: "layers12", recent: [], layerCounts: [0, 0, 0],
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
      const layerCounts: [number, number, number] = [0, 0, 0];
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
    if (!data) return { results: [] as EmailResult[], summary: emptySummary(), total: 0, discarded: 0, pending: 0, inconclusive: 0, hasSmtp: false };
    const results = pickOnePerCell(data.results, onePerCell);
    const summary = emptySummary();
    results.forEach((r) => summary[r.status]++);
    return {
      results, summary, total: results.length, discarded: data.results.length - results.length,
      pending: results.filter((r) => r.status === "valid" && r.layer === 2).length,
      inconclusive: results.filter((r) => r.status === "valid" && r.layer === 3 && !r.confirmed).length,
      hasSmtp: results.some((r) => r.layer === 3),
    };
  }, [data, onePerCell]);

  const invalid =
    view.summary.invalid_format + view.summary.invalid_mx + view.summary.invalid_mailbox +
    view.summary.invalid_disposable + view.summary.invalid_excluded;
  const risky = view.summary.risky_typo + view.summary.risky_role + view.summary.risky_catchall;

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
                  <strong>CSV limpio estricto: solo buzones confirmados por SMTP</strong>
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
                            SMTP ✓
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
