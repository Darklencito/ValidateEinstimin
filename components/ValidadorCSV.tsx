"use client";

import { DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle, ArrowRight, CheckCircle2, ChevronDown, ChevronUp, Clock, Copy,
  Download, FileCheck2, FileSpreadsheet, FileUp, FolderClock, History, Info,
  Loader2, Play, RefreshCw, RotateCcw, Search, ShieldAlert, Sparkles, Terminal,
  Trash2, Wand2, Wifi, XCircle,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { downloadCsv, parseCsvText, toCsv, type Row } from "@/lib/csv";
import {
  ALL_STATUSES, STATUS_LABEL, emptySummary,
  type EaBatchResponse, type EmailResult, type EmailStatus, type ExtProviderInfo,
  type SmtpBatchResponse, type StreamEvent, type ValidationResponse, type VerifiersStatus,
} from "@/lib/validation-types";
import {
  cacheEmailResults, computeCsvHash, deleteProcessedFile, findProcessedByHash,
  getCachedEmails, listProcessedFiles, makeLog, saveBuilderDraft, saveProcessedFile,
  type LogEntry, type LogLevel, type ProcessedFileRecord,
} from "@/lib/storage";
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
type ResultTab = "all" | "valid" | "confirmed" | "risky" | "invalid" | "unconfirmed";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** Detecta la columna de correo igual que el backend. */
function detectEmailColumn(columns: string[], rows: Row[]): string {
  const byName = columns.find((c) => /e-?mail|correo|mail/i.test(c));
  if (byName) return byName;
  const byContent = columns.find((c) => rows.slice(0, 20).some((r) => r[c]?.includes("@")));
  return byContent ?? columns[0] ?? "correo";
}

/**
 * Detecta si el CSV subido ya es un archivo de resultados exportado por este validador
 * (contiene columnas correo + estado + motivo, o estado_validacion).
 */
function parseAlreadyProcessedCsv(columns: string[], rows: Row[]): ValidationResponse | null {
  const norm = (s: string) => s.toLowerCase().trim();
  const colEmail = columns.find((c) => /^(correo|email|e-mail|mail)$/i.test(norm(c)));
  const colStatus = columns.find((c) => /^(estado|status|estado_validacion)$/i.test(norm(c)));
  const colReason = columns.find((c) => /^(motivo|reason|detalle)$/i.test(norm(c)));
  const colLayer = columns.find((c) => /^(capa|layer)$/i.test(norm(c)));
  const colConfirmed = columns.find((c) => /^(confirmado_smtp|confirmado|confirmed)$/i.test(norm(c)));
  const colSource = columns.find((c) => /^(celda_original|source)$/i.test(norm(c)));

  if (!colEmail || !colStatus) return null;

  // Mapa inverso de etiqueta o clave a EmailStatus
  const labelToStatus = new Map<string, EmailStatus>();
  for (const st of ALL_STATUSES) {
    labelToStatus.set(st.toLowerCase(), st);
    labelToStatus.set(STATUS_LABEL[st].toLowerCase(), st);
  }

  const results: EmailResult[] = [];
  let recognizedCount = 0;

  for (const r of rows) {
    const email = (r[colEmail] ?? "").trim();
    if (!email) continue;
    const rawSt = (r[colStatus] ?? "").trim().toLowerCase();
    const matched = labelToStatus.get(rawSt);
    if (matched) recognizedCount++;
    const status: EmailStatus = matched ?? "valid";
    const reason = colReason ? (r[colReason] ?? "").trim() || STATUS_LABEL[status] : STATUS_LABEL[status];
    const layerNum = colLayer ? Number(r[colLayer]) : undefined;
    const layer = layerNum === 1 || layerNum === 2 || layerNum === 3 || layerNum === 4 ? layerNum : 2;
    const confRaw = colConfirmed ? (r[colConfirmed] ?? "").trim().toLowerCase() : "";
    const confirmed = confRaw === "si" || confRaw === "sí" || confRaw === "true" || confRaw === "1";
    const source = colSource && r[colSource]?.trim() ? r[colSource].trim() : undefined;
    results.push({ email, status, reason, layer, confirmed, source });
  }

  // Al menos el 60% de las filas deben tener un estado válido reconocido del sistema
  if (results.length === 0 || recognizedCount < results.length * 0.6) return null;

  const summary = emptySummary();
  results.forEach((r) => summary[r.status]++);
  return {
    total: results.length,
    summary,
    results,
    multiCells: results.filter((r) => !!r.source).length,
    excludedListSize: summary.invalid_excluded,
  };
}

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

/** Extrae el dominio sugerido de un motivo como "¿Quisiste decir @gmail.com?" */
function extractSuggestedEmail(email: string, reason: string): string | null {
  const m = reason.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (!m) return null;
  const [local] = email.split("@");
  if (!local) return null;
  return `${local}@${m[1].toLowerCase()}`;
}

interface Connectivity { via: string; ok: boolean; ms: number; message: string }

export default function ValidadorCSV() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const excludeRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastFileRef = useRef<File | null>(null);

  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileSize, setFileSize] = useState(0);
  const [currentHash, setCurrentHash] = useState("");
  const [currentRecordId, setCurrentRecordId] = useState("");
  const [data, setData] = useState<ValidationResponse | null>(null);
  const [progress, setProgress] = useState<LiveProgress | null>(null);
  const [excludeFile, setExcludeFile] = useState<File | null>(null);

  // Datos originales del CSV para poder exportar con todas las columnas o enviar al Constructor
  const [rawColumns, setRawColumns] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Row[]>([]);
  const [emailColumn, setEmailColumn] = useState<string>("correo");
  const [keepOriginalCols, setKeepOriginalCols] = useState(true);

  // Estado de detección de "CSV ya procesado"
  const [alreadyProcessedBanner, setAlreadyProcessedBanner] = useState<{
    type: "hash_match" | "columns_match";
    processedAt: string;
    fileName: string;
  } | null>(null);

  // Historial de archivos procesados (IndexedDB)
  const [historyList, setHistoryList] = useState<ProcessedFileRecord[]>([]);
  const [showHistory, setShowHistory] = useState(true);

  // Consola de Logs al pie
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logFilter, setLogFilter] = useState<"all" | LogLevel>("all");
  const [logsOpen, setLogsOpen] = useState(true);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Filtros de la tabla de resultados
  const [resultTab, setResultTab] = useState<ResultTab>("all");
  const [resultSearch, setResultSearch] = useState("");

  // Capa 3 (SMTP) por lotes
  const [batchSize, setBatchSize] = useState(40);
  const [pauseSec, setPauseSec] = useState(10);
  const [checking, setChecking] = useState(false);
  const [connectivity, setConnectivity] = useState<Connectivity[] | null>(null);

  // Opciones de salida
  const [onePerCell, setOnePerCell] = useState(true);
  const [strictSmtp, setStrictSmtp] = useState(false);

  // Capa 4: verificación externa (EmailAwesome / emailval), opcional y con costo
  const [verifiers, setVerifiers] = useState<VerifiersStatus | null>(null);
  const [extMode, setExtMode] = useState<string>("auto");
  const [eaMax, setEaMax] = useState(500);

  const addLog = (level: LogLevel, step: string, message: string) => {
    setLogs((prev) => [...prev, makeLog(level, step, message)]);
  };

  // Auto-scroll de la consola de logs cuando llegan nuevos mensajes
  useEffect(() => {
    if (logsOpen && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, logsOpen]);

  // Cargar historial de archivos procesados al montar
  const refreshHistory = async () => {
    const items = await listProcessedFiles();
    setHistoryList(items);
  };

  const refreshEa = () =>
    fetch("/api/ea-status")
      .then((r) => r.json())
      .then((j: VerifiersStatus) => setVerifiers(j))
      .catch(() => setVerifiers({ order: [], providers: [] }));

  useEffect(() => {
    refreshEa();
    refreshHistory();
    setLogs([
      makeLog("info", "Sistema", "Validador listo. Sube un archivo CSV o selecciona uno de tu historial de archivos procesados."),
    ]);
  }, []);

  // Auto-guardar en IndexedDB cada vez que cambian `data` o `logs` de un archivo activo
  useEffect(() => {
    if (!data || !currentRecordId || !fileName) return;
    const timer = setTimeout(async () => {
      const existing = historyList.find((h) => h.id === currentRecordId);
      const record: ProcessedFileRecord = {
        id: currentRecordId,
        fileHash: currentHash,
        fileName,
        fileSize,
        processedAt: existing?.processedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        data,
        rawColumns,
        rawRows,
        emailColumn,
        logs,
      };
      await saveProcessedFile(record);
      await cacheEmailResults(data.results);
      await refreshHistory();
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, logs, currentRecordId]);

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
    addLog("info", "SMTP", "Probando conectividad saliente al puerto 25...");
    try {
      const res = await fetch("/api/smtp-check");
      const json = await res.json();
      const list: Connectivity[] = json.results ?? [];
      setConnectivity(list);
      const okCount = list.filter((c) => c.ok).length;
      if (okCount > 0) {
        addLog("success", "SMTP", `Conexión SMTP exitosa (${okCount}/${list.length} rutas operativas).`);
      } else {
        addLog("error", "SMTP", "Ninguna ruta pudo conectar al puerto 25. Verifica el firewall o configura SMTP_PROXIES.");
      }
    } catch {
      setConnectivity([{ via: "—", ok: false, ms: 0, message: "No se pudo ejecutar la prueba." }]);
      addLog("error", "SMTP", "Falló la solicitud al probar la conexión SMTP.");
    } finally {
      setChecking(false);
    }
  }

  // ---------- Capa 3: SMTP por lotes, con pausas y reintento ----------
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

    addLog(
      "info",
      "SMTP",
      `Iniciando Capa 3 (SMTP) para ${candidates.length.toLocaleString()} correos en ${batches} lote(s) de ${size} (pausa base: ${pauseSec}s).`
    );

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
      const t0 = Date.now();
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
          addLog("error", "SMTP", `Lote ${b + 1}/${batches} falló: ${stopReason}`);
          break;
        }
        res = json as SmtpBatchResponse;
      } catch (e) {
        if (!isAbort(e)) {
          stopReason = "Se perdió la conexión con el servidor durante la verificación SMTP.";
          addLog("error", "SMTP", stopReason);
        }
        break;
      }

      if (res.connectFailed >= slice.length) {
        stopReason =
          `No se pudo conectar al puerto 25 (${res.via}). Usa «Probar conexión SMTP» y, si tu hosting lo bloquea, ` +
          `configura un proxy SOCKS5 (variable SMTP_PROXIES).`;
        addLog("error", "SMTP", stopReason);
        break;
      }

      let batchConfirmed = 0;
      let batchInvalid = 0;
      let batchCatchAll = 0;
      for (const r of res.results) {
        const i = index.get(r.email.toLowerCase());
        if (i === undefined) continue;
        results[i] = { ...results[i], status: r.status, reason: r.reason, confirmed: r.confirmed, layer: 3 };
        recent.unshift(results[i]);
        if (r.confirmed && r.status === "valid") batchConfirmed++;
        else if (r.status === "invalid_mailbox") batchInvalid++;
        else if (r.status === "risky_catchall") batchCatchAll++;
      }
      if (recent.length > 40) recent.length = 40;
      done += slice.length;
      layerCounts[2] += res.results.length;

      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
      addLog(
        res.throttled > 0 ? "warn" : "success",
        "SMTP",
        `Lote ${b + 1}/${batches} (${res.via}, ${elapsedSec}s): ${batchConfirmed} confirmados, ${batchInvalid} inexistentes, ${batchCatchAll} catch-all` +
          (res.throttled > 0 ? ` · ${res.throttled} diferidos por rate-limit` : "")
      );

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
      addLog("warn", "SMTP", `Verificación SMTP pausada por el usuario tras procesar ${done} de ${candidates.length} correos.`);
    } else if (!stopReason) {
      addLog("success", "SMTP", `Verificación SMTP finalizada (${done.toLocaleString()} correos consultados).`);
    }

    const summary = emptySummary();
    results.forEach((r) => summary[r.status]++);
    setData({
      ...base, results, summary,
      notice: stopReason || (candidates.length === 0 ? "No había correos pendientes de verificar por SMTP." : undefined),
    });
  }

  // ---------- Capa 4: verificación externa ----------
  async function runExternal(
    base: ValidationResponse,
    controller: AbortController,
    providers: ExtProviderInfo[],
    maxSend: number
  ) {
    const results = base.results.map((r) => ({ ...r }));
    const index = new Map<string, number>();
    results.forEach((r, i) => index.set(r.email.toLowerCase(), i));

    const sent = new Set<string>();
    const notes: string[] = [];
    const recent: EmailResult[] = [];
    const layerCounts: [number, number, number, number] = [0, 0, 0, 0];
    let done = 0;
    let budget = Math.max(maxSend, 0);
    const total = budget;
    let unfinished = 0;

    addLog(
      "info",
      "Externa",
      `Iniciando Capa 4 con proveedor(es): ${providers.map((p) => p.name).join(" → ")} (presupuesto máx: ${budget} correos).`
    );

    const show = (statusText: string) =>
      setProgress({
        done, total, phase: "ea", statusText,
        recent: recent.slice(0, 40), layerCounts: [...layerCounts],
        ...tally(pickOnePerCell(results, onePerCell)),
      });

    for (let pi = 0; pi < providers.length; pi++) {
      const p = providers[pi];
      if (controller.signal.aborted || budget <= 0) break;

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
      if (p.balance !== null) list = list.slice(0, Math.max(p.balance, 0));
      list = list.slice(0, budget);
      if (skipped > 0) {
        const msg = `${skipped} correos de Gmail/Outlook/Yahoo/Apple no se enviaron a ${p.name} para ahorrar créditos.`;
        notes.push(msg);
        addLog("info", "Externa", msg);
      }
      if (list.length === 0) continue;

      const pending = new Map<string, string>();
      let stopped = "";

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
            addLog("error", "Externa", `${p.name}: ${stopped}`);
            return false;
          }
          res = json as EaBatchResponse;
        } catch (e) {
          if (!isAbort(e)) {
            stopped = `Se perdió la conexión con el servidor durante la verificación con ${p.name}.`;
            addLog("error", "Externa", stopped);
          }
          return false;
        }

        let batchDone = 0;
        for (const it of res.items) {
          const i = index.get(it.email.toLowerCase());
          if (it.state === "done" && it.status && i !== undefined) {
            results[i] = { ...results[i], status: it.status, reason: it.reason ?? "", confirmed: !!it.confirmed, layer: 4 };
            pending.delete(it.email);
            recent.unshift(results[i]);
            layerCounts[3]++;
            done++;
            batchDone++;
          } else if (it.id) {
            pending.set(it.email, it.id);
          }
        }
        if (batchDone > 0) {
          addLog("success", "Externa", `${p.name}: ${batchDone} correo(s) verificados en este lote (${pending.size} en espera).`);
        }
        if (recent.length > 40) recent.length = 40;
        if (res.fatal) {
          stopped = res.fatal;
          addLog("warn", "Externa", `${p.name}: ${res.fatal}`);
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
      addLog("warn", "Externa", "Verificación externa detenida por el usuario.");
    } else {
      addLog("success", "Externa", `Capa 4 finalizada: ${done} correo(s) resueltos por proveedor externo.`);
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
      const msg = e instanceof Error ? e.message : "Error durante la verificación externa";
      setError(msg);
      addLog("error", "Externa", msg);
    } finally {
      refreshEa();
      window.dispatchEvent(new Event("credits:refresh"));
      abortRef.current = null;
      setProgress(null);
      setLoading(false);
    }
  }

  // ---------- Cargar un archivo desde el historial ----------
  function openHistoryRecord(rec: ProcessedFileRecord, bannerType?: "hash_match" | "columns_match") {
    setError("");
    setFileName(rec.fileName);
    setFileSize(rec.fileSize);
    setCurrentHash(rec.fileHash);
    setCurrentRecordId(rec.id);
    setData(rec.data);
    setRawColumns(rec.rawColumns ?? []);
    setRawRows(rec.rawRows ?? []);
    setEmailColumn(rec.emailColumn || "correo");
    setResultTab("all");
    setResultSearch("");
    if (bannerType) {
      setAlreadyProcessedBanner({
        type: bannerType,
        processedAt: rec.updatedAt,
        fileName: rec.fileName,
      });
    } else {
      setAlreadyProcessedBanner(null);
    }
    const restoredLogs = rec.logs?.length ? rec.logs : [];
    setLogs([
      ...restoredLogs,
      makeLog(
        "info",
        "Historial",
        `Se restauró el archivo procesado «${rec.fileName}» (${rec.data.total.toLocaleString()} correos, ${rec.data.summary.valid.toLocaleString()} válidos).`
      ),
    ]);
  }

  // ---------- Capas 1 y 2 (stream) + Detección de CSV ya procesado ----------
  async function handleFile(file: File, forceReprocess = false) {
    setError("");
    setAlreadyProcessedBanner(null);
    if (!/\.csv$/i.test(file.name)) {
      setError("El archivo debe tener extensión .csv");
      addLog("error", "Archivo", `Archivo rechazado (${file.name}): no tiene extensión .csv`);
      return;
    }

    lastFileRef.current = file;
    const text = await file.text();
    const hash = await computeCsvHash(text);
    const parsed = parseCsvText(text);
    const detectedCol = detectEmailColumn(parsed.columns, parsed.rows);

    // 1. ¿Ya fue procesado exactamente este CSV antes? (mismo hash SHA-256)
    if (!forceReprocess) {
      const existing = await findProcessedByHash(hash);
      if (existing) {
        openHistoryRecord(existing, "hash_match");
        addLog(
          "warn",
          "Archivo",
          `¡CSV detectado como ya procesado! «${file.name}» coincide exactamente con el procesado el ${new Date(existing.updatedAt).toLocaleString("es")}. Se cargaron los resultados instantáneamente.`
        );
        return;
      }

      // 2. ¿Es un CSV que ya trae las columnas de resultados del validador (correo, estado, motivo...)?
      const imported = parseAlreadyProcessedCsv(parsed.columns, parsed.rows);
      if (imported) {
        const recId = `rec_${hash.slice(0, 16)}`;
        const initialLogs: LogEntry[] = [
          makeLog(
            "success",
            "Archivo",
            `El archivo «${file.name}» ya contiene columnas de validación (${imported.total.toLocaleString()} correos). Se importaron directamente sin repetir Capas 1 y 2.`
          ),
        ];
        setFileName(file.name);
        setFileSize(file.size);
        setCurrentHash(hash);
        setCurrentRecordId(recId);
        setRawColumns(parsed.columns);
        setRawRows(parsed.rows);
        setEmailColumn(detectedCol);
        setData(imported);
        setLogs(initialLogs);
        setAlreadyProcessedBanner({
          type: "columns_match",
          processedAt: new Date().toISOString(),
          fileName: file.name,
        });
        return;
      }
    }

    // 3. Procesamiento normal (Capas 1 y 2)
    setData(null);
    setFileName(file.name);
    setFileSize(file.size);
    setCurrentHash(hash);
    const recId = `rec_${hash.slice(0, 16)}_${Date.now()}`;
    setCurrentRecordId(recId);
    setRawColumns(parsed.columns);
    setRawRows(parsed.rows);
    setEmailColumn(detectedCol);
    setResultTab("all");
    setResultSearch("");

    const startLogs: LogEntry[] = [
      makeLog(
        "info",
        "Archivo",
        `Cargado «${file.name}» (${(file.size / 1024).toFixed(1)} KB · ${parsed.rows.length.toLocaleString()} filas · columna de correo detectada: «${detectedCol}»).`
      ),
    ];
    if (excludeFile) {
      startLogs.push(makeLog("info", "Archivo", `Lista de exclusión adjunta: «${excludeFile.name}».`));
    }
    setLogs(startLogs);

    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({
      done: 0, total: 0, phase: "layers12", recent: [], layerCounts: [0, 0, 0, 0],
      valid: 0, invalid: 0, risky: 0,
    });

    const t0 = Date.now();
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

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const all: EmailResult[] = [];
      const recent: EmailResult[] = [];
      const layerCounts: [number, number, number, number] = [0, 0, 0, 0];
      let total = 0, done = 0, valid = 0, invalid = 0, risky = 0;
      let meta: StreamMeta | null = null;
      let buffer = "";
      let lastFlush = 0;

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
      let results = all.filter(Boolean);

      // Cruzar con la caché local de correos ya confirmados en ejecuciones anteriores (Capa 3 / Capa 4)
      let cacheHits = 0;
      if (!forceReprocess) {
        const cachedMap = await getCachedEmails(results.map((r) => r.email));
        if (cachedMap.size > 0) {
          results = results.map((r) => {
            if (r.status !== "valid") return r;
            const hit = cachedMap.get(r.email.toLowerCase());
            if (hit && ((hit.layer && hit.layer >= 3) || hit.confirmed)) {
              cacheHits++;
              return { ...r, status: hit.status, reason: `${hit.reason} (recuperado de caché)`, layer: hit.layer, confirmed: hit.confirmed };
            }
            return r;
          });
        }
      }

      const summary = emptySummary();
      results.forEach((r) => summary[r.status]++);
      const base: ValidationResponse = { total: results.length, summary, results, ...(meta as StreamMeta) };
      setData(base);

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      addLog(
        "success",
        "Capa 1-2",
        `Capas 1 y 2 completadas en ${elapsed}s · Total únicos: ${results.length.toLocaleString()} · Válidos: ${summary.valid.toLocaleString()} · Riesgo: ${(summary.risky_typo + summary.risky_role + summary.risky_catchall).toLocaleString()} · Inválidos: ${(summary.invalid_format + summary.invalid_mx + summary.invalid_mailbox + summary.invalid_disposable + summary.invalid_excluded).toLocaleString()}.`
      );
      if ((meta as StreamMeta).multiCells > 0) {
        addLog("info", "Capa 1-2", `Se detectaron ${(meta as StreamMeta).multiCells} celdas con múltiples correos separados.`);
      }
      if (cacheHits > 0) {
        addLog("success", "Caché", `Se recuperaron ${cacheHits.toLocaleString()} correos ya verificados previamente por SMTP/Externa (ahorro de tiempo y créditos).`);
      }
    } catch (e) {
      const msg = isAbort(e) ? "Validación cancelada por el usuario." : e instanceof Error ? e.message : "Error de conexión";
      setError(msg);
      addLog(isAbort(e) ? "warn" : "error", "Capa 1-2", msg);
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
      const msg = e instanceof Error ? e.message : "Error durante la verificación SMTP";
      setError(msg);
      addLog("error", "SMTP", msg);
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

  // ---------- Corrección de errores de tipeo (risky_typo) en 1 clic ----------
  function fixTypos(targetEmail?: string) {
    if (!data) return;
    let fixedCount = 0;
    const updated = data.results.map((r) => {
      if (r.status !== "risky_typo") return r;
      if (targetEmail && r.email !== targetEmail) return r;
      const suggested = extractSuggestedEmail(r.email, r.reason);
      if (!suggested) return r;
      fixedCount++;
      return {
        ...r,
        email: suggested,
        status: "valid" as EmailStatus,
        reason: `Dominio corregido automáticamente (antes: ${r.email})`,
        layer: 2 as const,
      };
    });
    if (fixedCount === 0) return;
    const summary = emptySummary();
    updated.forEach((r) => summary[r.status]++);
    setData({ ...data, results: updated, summary });
    addLog("success", "Corrección", `Se corrigieron ${fixedCount} correo(s) con error de tipeo y pasaron a Válidos.`);
  }

  // ---------- Resultados que se muestran y descargan ----------
  const view = useMemo(() => {
    if (!data) {
      return {
        results: [] as EmailResult[],
        summary: emptySummary(),
        total: 0,
        discarded: 0,
        pending: 0,
        inconclusive: 0,
        unconfirmed: 0,
        confirmedCount: 0,
        hasSmtp: false,
        typos: [] as { original: string; suggested: string }[],
      };
    }
    const results = pickOnePerCell(data.results, onePerCell);
    const summary = emptySummary();
    results.forEach((r) => summary[r.status]++);
    const typos: { original: string; suggested: string }[] = [];
    for (const r of results) {
      if (r.status === "risky_typo") {
        const s = extractSuggestedEmail(r.email, r.reason);
        if (s) typos.push({ original: r.email, suggested: s });
      }
    }
    return {
      results,
      summary,
      total: results.length,
      discarded: data.results.length - results.length,
      pending: results.filter((r) => r.status === "valid" && r.layer === 2).length,
      inconclusive: results.filter((r) => r.status === "valid" && r.layer === 3 && !r.confirmed).length,
      unconfirmed: results.filter((r) => r.status === "valid" && !r.confirmed).length,
      confirmedCount: results.filter((r) => r.status === "valid" && !!r.confirmed).length,
      hasSmtp: results.some((r) => r.layer === 3),
      typos,
    };
  }, [data, onePerCell]);

  // Filtrado de la tabla de resultados por pestaña + búsqueda
  const filteredResults = useMemo(() => {
    const q = resultSearch.trim().toLowerCase();
    return view.results.filter((r) => {
      if (resultTab === "valid" && r.status !== "valid") return false;
      if (resultTab === "confirmed" && !(r.status === "valid" && r.confirmed)) return false;
      if (resultTab === "risky" && !r.status.startsWith("risky_")) return false;
      if (resultTab === "invalid" && !r.status.startsWith("invalid_")) return false;
      if (resultTab === "unconfirmed" && !(r.status === "valid" && !r.confirmed)) return false;
      if (q && !r.email.toLowerCase().includes(q) && !r.reason.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [view.results, resultTab, resultSearch]);

  const invalid =
    view.summary.invalid_format + view.summary.invalid_mx + view.summary.invalid_mailbox +
    view.summary.invalid_disposable + view.summary.invalid_excluded;
  const risky = view.summary.risky_typo + view.summary.risky_role + view.summary.risky_catchall;
  const extCapacity = extProviders.reduce((s, p) => s + (p.balance ?? Infinity), 0);
  const eaN = Math.max(0, Math.min(view.unconfirmed, Math.max(eaMax, 0), extCapacity));

  /** Construye las filas limpias (con todas las columnas originales si están disponibles, o solo correo). */
  function buildCleanData(
    sourceResults = view.results,
    cols = rawColumns,
    rows = rawRows,
    colMail = emailColumn,
    preserveAllCols = keepOriginalCols
  ): { columns: string[]; rows: Row[] } {
    const validSet = new Map<string, string>(); // correo_lower o celda_lower -> correo limpio
    for (const r of sourceResults) {
      if (r.status === "valid" && (!strictSmtp || r.confirmed)) {
        validSet.set(r.email.toLowerCase(), r.email);
        if (r.source) validSet.set(r.source.toLowerCase().trim(), r.email);
      }
    }

    if (preserveAllCols && cols.length > 0 && rows.length > 0) {
      const outRows: Row[] = [];
      const seenEmails = new Set<string>();
      for (const r of rows) {
        const rawCell = (r[colMail] ?? "").trim();
        if (!rawCell) continue;
        // Buscar coincidencia directa o por partes
        let cleanEmail = validSet.get(rawCell.toLowerCase());
        if (!cleanEmail) {
          const parts = rawCell.split(/[\s/;,|]+/).filter(Boolean);
          for (const p of parts) {
            const match = validSet.get(p.toLowerCase());
            if (match) {
              cleanEmail = match;
              break;
            }
          }
        }
        if (cleanEmail && !seenEmails.has(cleanEmail.toLowerCase())) {
          seenEmails.add(cleanEmail.toLowerCase());
          outRows.push({ ...r, [colMail]: cleanEmail });
        }
      }
      if (outRows.length > 0) {
        return { columns: cols, rows: outRows };
      }
    }

    const fallbackRows = sourceResults
      .filter((r) => r.status === "valid" && (!strictSmtp || r.confirmed))
      .map((r) => ({ correo: r.email }));
    return { columns: ["correo"], rows: fallbackRows };
  }

  function downloadClean() {
    const { columns: cols, rows } = buildCleanData();
    const baseName = fileName ? fileName.replace(/\.csv$/i, "") : "correos";
    const outName = `${baseName}_validos.csv`;
    downloadCsv(outName, toCsv(rows, cols));
    addLog("success", "Exportación", `Descargado «${outName}» con ${rows.length.toLocaleString()} filas válidas (${cols.length} columnas).`);
  }

  function downloadFull() {
    const rows = view.results.map((r) => ({
      correo: r.email,
      estado: STATUS_LABEL[r.status],
      motivo: r.reason,
      capa: r.layer ? String(r.layer) : "",
      confirmado_smtp: r.confirmed ? "si" : "no",
      celda_original: r.source ?? "",
    }));
    const baseName = fileName ? fileName.replace(/\.csv$/i, "") : "resultado";
    const outName = `${baseName}_completo.csv`;
    downloadCsv(
      outName,
      toCsv(rows, ["correo", "estado", "motivo", "capa", "confirmado_smtp", "celda_original"])
    );
    addLog("info", "Exportación", `Descargado reporte completo «${outName}» (${rows.length.toLocaleString()} correos).`);
  }

  /** Envía los correos válidos con todas sus columnas al Constructor para armar el CSV de Brevo. */
  function sendToConstructor(customRec?: ProcessedFileRecord) {
    const targetResults = customRec ? pickOnePerCell(customRec.data.results, onePerCell) : view.results;
    const targetCols = customRec ? customRec.rawColumns : rawColumns;
    const targetRows = customRec ? customRec.rawRows : rawRows;
    const targetMailCol = customRec ? customRec.emailColumn : emailColumn;
    const targetName = customRec ? customRec.fileName : fileName;

    const { columns: cols, rows } = buildCleanData(targetResults, targetCols, targetRows, targetMailCol, true);
    saveBuilderDraft({
      fileName: targetName || "validados.csv",
      columns: cols,
      rows,
      fromValidator: true,
    });
    router.push("/dashboard/constructor");
  }

  function copyLogsToClipboard() {
    const text = logs.map((l) => `[${l.time}] [${l.step}] (${l.level.toUpperCase()}) ${l.message}`).join("\n");
    navigator.clipboard.writeText(text);
    setCopiedLogs(true);
    setTimeout(() => setCopiedLogs(false), 2000);
  }

  function downloadLogsFile() {
    const text = logs.map((l) => `[${l.time}] [${l.step}] (${l.level.toUpperCase()}) ${l.message}`).join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs_${(fileName || "validador").replace(/\.csv$/i, "")}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const cleanCount = view.results.filter((r) => r.status === "valid" && (!strictSmtp || r.confirmed)).length;
  const visibleLogs = logFilter === "all" ? logs : logs.filter((l) => l.level === logFilter);

  return (
    <div className="space-y-6">
      {progress && (
        <ValidationProgressModal
          progress={progress}
          fileName={fileName}
          onCancel={() => abortRef.current?.abort()}
        />
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Validador de correos</h1>
          <p className="text-sm text-slate-500">
            Sube un CSV con tus contactos. Detecta automáticamente si el archivo ya fue procesado, conserva tus
            columnas originales y guarda todo en tu historial local.
          </p>
        </div>
        {historyList.length > 0 && (
          <Button
            variant="secondary"
            onClick={() => setShowHistory((v) => !v)}
            className="shrink-0"
          >
            <FolderClock size={16} className="text-indigo-600" />
            Archivos procesados ({historyList.length})
            {showHistory ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </Button>
        )}
      </div>

      {/* BANDEJA DE ARCHIVOS PROCESADOS */}
      {historyList.length > 0 && showHistory && (
        <Card className="space-y-3 border-indigo-100 bg-gradient-to-br from-white to-indigo-50/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700">
                <History size={17} />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-slate-800">Bandeja de archivos procesados</h2>
                <p className="text-xs text-slate-500">
                  Tus validaciones se guardan automáticamente aquí. Haz clic en cualquiera para reabrirla o enviarla a Brevo.
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {historyList.map((rec) => {
              const isCurrent = rec.id === currentRecordId;
              const s = rec.data.summary;
              const vCount = s.valid;
              const rCount = s.risky_typo + s.risky_role + s.risky_catchall;
              const iCount =
                s.invalid_format + s.invalid_mx + s.invalid_mailbox + s.invalid_disposable + s.invalid_excluded;
              const tot = Math.max(rec.data.total, 1);
              const hasL4 = rec.data.results.some((r) => r.layer === 4);
              const hasL3 = rec.data.results.some((r) => r.layer === 3);
              const maxLayerLabel = hasL4 ? "Capa 4 (Ext)" : hasL3 ? "Capa 3 (SMTP)" : "Capas 1-2";

              return (
                <div
                  key={rec.id}
                  className={`flex flex-col justify-between rounded-xl border p-3.5 transition ${
                    isCurrent
                      ? "border-indigo-500 bg-indigo-50/60 ring-2 ring-indigo-500/20"
                      : "border-slate-200 bg-white hover:border-indigo-300 hover:shadow-sm"
                  }`}
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileCheck2 size={18} className="shrink-0 text-indigo-600" />
                        <p className="truncate text-sm font-semibold text-slate-800" title={rec.fileName}>
                          {rec.fileName}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                        {maxLayerLabel}
                      </span>
                    </div>

                    <p className="mt-1 flex items-center gap-1 text-xs text-slate-400">
                      <Clock size={12} />
                      {new Date(rec.updatedAt).toLocaleString("es", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {" · "}
                      {rec.data.total.toLocaleString()} correos
                    </p>

                    {/* Barra de proporción Válidos / Riesgo / Inválidos */}
                    <div className="mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="bg-emerald-500"
                        style={{ width: `${(vCount / tot) * 100}%` }}
                        title={`Válidos: ${vCount}`}
                      />
                      <div
                        className="bg-amber-400"
                        style={{ width: `${(rCount / tot) * 100}%` }}
                        title={`Riesgo: ${rCount}`}
                      />
                      <div
                        className="bg-rose-500"
                        style={{ width: `${(iCount / tot) * 100}%` }}
                        title={`Inválidos: ${iCount}`}
                      />
                    </div>

                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                      <span className="font-medium text-emerald-700">✓ {vCount.toLocaleString()} válidos</span>
                      <span className="text-amber-700">⚠ {rCount.toLocaleString()} riesgo</span>
                      <span className="text-rose-700">✕ {iCount.toLocaleString()} inv.</span>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-1.5 border-t border-slate-100 pt-2.5">
                    <button
                      type="button"
                      onClick={() => openHistoryRecord(rec)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                        isCurrent
                          ? "bg-indigo-600 text-white"
                          : "bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                      }`}
                    >
                      {isCurrent ? "Abierto ahora" : "Abrir resultados"}
                    </button>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => sendToConstructor(rec)}
                        title="Abrir válidos en el Constructor para Brevo"
                        className="rounded-lg px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-indigo-600"
                      >
                        Constructor →
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await deleteProcessedFile(rec.id);
                          await refreshHistory();
                          addLog("info", "Historial", `Eliminado del historial: «${rec.fileName}».`);
                        }}
                        title="Eliminar del historial"
                        className="rounded-lg p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* BANNER: ESTE CSV YA SE PROCESÓ */}
      {alreadyProcessedBanner && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-emerald-300 bg-emerald-50/90 p-4 text-sm text-emerald-950 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm">
              <FileCheck2 size={20} />
            </span>
            <div>
              <p className="font-semibold text-emerald-900">
                ¡Este archivo CSV ya se procesó anteriormente!
              </p>
              <p className="text-emerald-800">
                {alreadyProcessedBanner.type === "hash_match" ? (
                  <>
                    El contenido de <strong>{alreadyProcessedBanner.fileName}</strong> es idéntico al procesado el{" "}
                    <strong>{new Date(alreadyProcessedBanner.processedAt).toLocaleString("es")}</strong>. Cargamos sus
                    resultados y confirmaciones al instante para que no gastes tiempo ni créditos de nuevo.
                  </>
                ) : (
                  <>
                    El archivo <strong>{alreadyProcessedBanner.fileName}</strong> ya incluye las columnas de validación
                    de este sistema. Se importaron los estados directamente.
                  </>
                )}
              </p>
            </div>
          </div>
          {lastFileRef.current && (
            <Button
              variant="secondary"
              onClick={() => lastFileRef.current && handleFile(lastFileRef.current, true)}
              disabled={loading}
              className="border-emerald-300 bg-white text-emerald-900 hover:bg-emerald-100"
            >
              <RotateCcw size={15} /> Volver a procesar desde cero
            </Button>
          )}
        </div>
      )}

      <Card className="space-y-4">
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
              <p className="text-xs text-slate-500">
                Máx. 5 MB · 10.000 correos · Si el CSV ya fue procesado antes, lo detectaremos al instante
              </p>
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
              e.target.value = "";
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

          {/* CORRECCIÓN EN 1 CLIC DE ERRORES DE TIPEO (risky_typo) */}
          {view.typos.length > 0 && (
            <Card className="border-amber-200 bg-amber-50/70 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-start gap-2.5 text-sm">
                  <Wand2 size={18} className="mt-0.5 shrink-0 text-amber-700" />
                  <div>
                    <p className="font-semibold text-amber-900">
                      Se detectaron {view.typos.length} correo(s) con posibles errores de escritura en el dominio
                    </p>
                    <p className="text-xs text-amber-800">
                      Puedes corregirlos automáticamente para recuperar esos contactos como válidos antes de exportar a Brevo.
                    </p>
                  </div>
                </div>
                <Button
                  onClick={() => fixTypos()}
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                >
                  <Sparkles size={15} /> Corregir todos ({view.typos.length})
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {view.typos.slice(0, 12).map((t) => (
                  <button
                    key={t.original}
                    type="button"
                    onClick={() => fixTypos(t.original)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs text-slate-700 shadow-sm hover:border-amber-500 hover:bg-amber-50"
                    title="Haz clic para aplicar esta corrección"
                  >
                    <span className="line-through text-red-600">{t.original}</span>
                    <ArrowRight size={12} className="text-slate-400" />
                    <span className="font-semibold text-emerald-700">{t.suggested}</span>
                  </button>
                ))}
                {view.typos.length > 12 && (
                  <span className="self-center text-xs text-amber-800">
                    +{view.typos.length - 12} más...
                  </span>
                )}
              </div>
            </Card>
          )}

          {data.excludedListSize > 0 && (
            <div className="flex items-center gap-2 rounded-lg bg-indigo-50 p-3 text-sm text-indigo-800">
              <Info size={16} /> Se usó tu lista de exclusión ({data.excludedListSize} correos).
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat icon={<CheckCircle2 />} label="Válidos (seguros para enviar)" value={view.summary.valid} color="text-green-600"
              hint={view.confirmedCount > 0 ? `${view.confirmedCount.toLocaleString()} confirmados por SMTP/Externa` : undefined} />
            <Stat icon={<XCircle />} label="Inválidos / excluidos" value={invalid} color="text-red-600"
              hint={`Formato ${view.summary.invalid_format} · MX ${view.summary.invalid_mx} · Buzón ${view.summary.invalid_mailbox} · Desechables ${view.summary.invalid_disposable} · Lista ${view.summary.invalid_excluded}`} />
            <Stat icon={<ShieldAlert />} label="Riesgo (no incluidos)" value={risky} color="text-amber-600"
              hint={`Tipeo ${view.summary.risky_typo} · Genéricas ${view.summary.risky_role} · Catch-all ${view.summary.risky_catchall}`} />
            <Stat icon={<FileUp />} label="Total únicos" value={view.total} color="text-slate-700"
              hint={rawColumns.length > 1 ? `${rawColumns.length} columnas originales conservadas` : undefined} />
          </div>

          {/* Capa 3: SMTP gratis */}
          {(view.pending > 0 || view.inconclusive > 0) && (
            <Card className="space-y-3 border-slate-200 text-sm">
              <div>
                <p className="flex items-center gap-2 font-medium">
                  Paso 2 · Capa 3: verificación SMTP
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">gratis</span>
                </p>
                <p className="text-slate-500">
                  {view.hasSmtp ? (
                    <>
                      {view.pending > 0 && <>Quedan <strong>{view.pending.toLocaleString()}</strong> correos sin verificar por SMTP. </>}
                      {view.inconclusive > 0 && (
                        <><strong>{view.inconclusive.toLocaleString()}</strong> quedaron «no concluyentes» (el servidor no dio una respuesta clara). </>
                      )}
                    </>
                  ) : (
                    <>
                      <strong>{view.pending.toLocaleString()}</strong> correos pasaron las capas 1 y 2 (formato, dominio y MX).{" "}
                    </>
                  )}
                  Esta capa pregunta al servidor de correo si el buzón existe, <strong>sin costo</strong>. Se hace por
                  lotes con pausas para no saturar al servidor ni bloquear tu hosting. Todo avance se guarda automáticamente.
                </p>
              </div>

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

              <div className="flex flex-wrap gap-2">
                {view.pending > 0 && (
                  <Button onClick={() => continueSmtp(false)} disabled={loading}>
                    <Play size={16} />
                    {view.hasSmtp ? "Continuar verificación SMTP" : `Verificar ${view.pending.toLocaleString()} por SMTP`}
                  </Button>
                )}
                {view.inconclusive > 0 && (
                  <Button variant="secondary" onClick={() => continueSmtp(true)} disabled={loading}>
                    <RefreshCw size={16} /> Reintentar los no concluyentes
                  </Button>
                )}
              </div>
            </Card>
          )}

          {/* Capa 4: verificación externa */}
          {view.unconfirmed > 0 && (
            <Card className="space-y-3 border-slate-200 text-sm">
              <div>
                <p className="font-medium">Paso 3 · Capa 4: verificación externa (opcional)</p>
                <p className="text-slate-500">
                  Hay <strong>{view.unconfirmed.toLocaleString()}</strong> correos válidos que ningún servidor confirmó
                  (no concluyentes o sin SMTP). Un proveedor externo puede confirmarlos, pero <strong>tiene costo</strong>.
                  Nunca se envía nada sin que lo confirmes.
                </p>
                {view.pending > 0 && (
                  <p className="mt-2 rounded-lg bg-green-50 p-2 text-green-800">
                    Todavía no usaste la capa 3 (gratis) en <strong>{view.pending.toLocaleString()}</strong> correos.
                    Hazla primero: así gastas menos créditos.
                  </p>
                )}
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

          {/* DESCARGA Y TABLA DE RESULTADOS */}
          <Card className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-2">
                {view.hasSmtp && (
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={strictSmtp}
                      onChange={(e) => setStrictSmtp(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      <strong>CSV limpio estricto: solo buzones confirmados (SMTP o Externa)</strong>
                      <span className="block text-xs text-slate-500">
                        Si lo desmarcas, el CSV limpio también incluye los válidos «no concluyentes».
                      </span>
                    </span>
                  </label>
                )}

                {rawColumns.length > 1 && (
                  <label className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={keepOriginalCols}
                      onChange={(e) => setKeepOriginalCols(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      <strong>Conservar todas las columnas originales del CSV ({rawColumns.join(", ")})</strong>
                      <span className="block text-xs text-slate-500">
                        Ideal para Brevo: mantiene nombre, teléfono, ciudad, etc. de cada contacto válido.
                      </span>
                    </span>
                  </label>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={downloadClean} disabled={cleanCount === 0}>
                  <Download size={16} /> CSV limpio ({cleanCount.toLocaleString()})
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => sendToConstructor()}
                  disabled={cleanCount === 0}
                  className="border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                >
                  <FileSpreadsheet size={16} /> Abrir en Constructor (Brevo) →
                </Button>
                <Button variant="secondary" onClick={downloadFull}>
                  <Download size={16} /> CSV completo
                </Button>
              </div>
            </div>

            {/* Pestañas de filtro y buscador */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
              <div className="flex flex-wrap gap-1.5">
                {([
                  { id: "all", label: "Todos", count: view.total },
                  { id: "valid", label: "Válidos", count: view.summary.valid },
                  { id: "confirmed", label: "Confirmados ✓", count: view.confirmedCount },
                  { id: "unconfirmed", label: "Sin confirmar", count: view.unconfirmed },
                  { id: "risky", label: "Riesgo / Tipeo", count: risky },
                  { id: "invalid", label: "Inválidos", count: invalid },
                ] as { id: ResultTab; label: string; count: number }[]).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setResultTab(t.id)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                      resultTab === t.id
                        ? "bg-indigo-600 text-white"
                        : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {t.label} ({t.count.toLocaleString()})
                  </button>
                ))}
              </div>

              <div className="relative min-w-[15rem]">
                <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
                <Input
                  className="py-1.5 pl-8 text-xs"
                  placeholder="Buscar correo o motivo..."
                  value={resultSearch}
                  onChange={(e) => setResultSearch(e.target.value)}
                />
              </div>
            </div>

            <div className="max-h-[28rem] overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-slate-100 text-xs uppercase text-slate-600">
                  <tr>
                    <th className="px-3 py-2">Correo</th>
                    <th className="px-3 py-2">Estado</th>
                    <th className="px-3 py-2">Motivo</th>
                    <th className="px-3 py-2 text-right">Acción</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredResults.map((r, i) => {
                    const suggested = r.status === "risky_typo" ? extractSuggestedEmail(r.email, r.reason) : null;
                    return (
                      <tr key={i} className="hover:bg-slate-50/80">
                        <td className="px-3 py-2 break-all font-medium text-slate-800">{r.email}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[r.status]}`}>
                            {STATUS_LABEL[r.status]}
                          </span>
                          {r.confirmed && (
                            <span className="ml-1 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
                              {r.layer === 4 ? "Externa ✓" : "SMTP ✓"}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-600">{r.reason}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {suggested && (
                            <button
                              type="button"
                              onClick={() => fixTypos(r.email)}
                              className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-200"
                            >
                              Corregir a {suggested}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredResults.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-slate-400">
                        No hay correos que coincidan con el filtro seleccionado.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/* PIE: CONSOLA DE LOGS Y ACTIVIDAD EN VIVO */}
      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-200 shadow-lg">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/90 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
            <Terminal size={15} className="text-indigo-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-200">
              Bitácora de procesamiento (Logs)
            </span>
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
              {logs.length} evento(s)
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {([
              { id: "all", label: "Todos" },
              { id: "success", label: "Éxitos" },
              { id: "warn", label: "Avisos" },
              { id: "error", label: "Errores" },
            ] as { id: "all" | LogLevel; label: string }[]).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setLogFilter(f.id)}
                className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition ${
                  logFilter === f.id
                    ? "bg-indigo-600 text-white"
                    : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                }`}
              >
                {f.label}
              </button>
            ))}

            <span className="mx-1 h-3 w-px bg-slate-800" />

            <button
              type="button"
              onClick={copyLogsToClipboard}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
              title="Copiar bitácora"
            >
              <Copy size={13} /> {copiedLogs ? "Copiado" : "Copiar"}
            </button>
            <button
              type="button"
              onClick={downloadLogsFile}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
              title="Descargar archivo .log"
            >
              <Download size={13} /> .log
            </button>
            <button
              type="button"
              onClick={() => setLogs([makeLog("info", "Sistema", "Bitácora limpiada.")])}
              className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
              title="Limpiar bitácora"
            >
              Limpiar
            </button>
            <button
              type="button"
              onClick={() => setLogsOpen((v) => !v)}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              aria-label="Mostrar u ocultar bitácora"
            >
              {logsOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
            </button>
          </div>
        </div>

        {logsOpen && (
          <div
            ref={logContainerRef}
            className="max-h-56 overflow-y-auto p-3 font-mono text-xs leading-relaxed space-y-1.5"
          >
            {visibleLogs.map((l) => {
              const badgeColor =
                l.level === "success"
                  ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                  : l.level === "warn"
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
                    : l.level === "error"
                      ? "bg-rose-500/20 text-rose-300 border-rose-500/30"
                      : "bg-sky-500/20 text-sky-300 border-sky-500/30";
              return (
                <div key={l.id} className="flex items-start gap-2 rounded px-1.5 py-0.5 hover:bg-white/5">
                  <span className="shrink-0 text-slate-500">[{l.time}]</span>
                  <span className={`shrink-0 rounded border px-1.5 py-0 text-[10px] font-semibold ${badgeColor}`}>
                    {l.step}
                  </span>
                  <span className="text-slate-200 break-words">{l.message}</span>
                </div>
              );
            })}
            {visibleLogs.length === 0 && (
              <p className="py-4 text-center text-slate-500">No hay registros en este filtro.</p>
            )}
          </div>
        )}
      </div>
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
        <p className="text-2xl font-semibold">{value.toLocaleString()}</p>
        <p className="text-sm text-slate-500">{label}</p>
        {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
      </div>
    </Card>
  );
}
