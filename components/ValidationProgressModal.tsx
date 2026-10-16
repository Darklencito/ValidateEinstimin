"use client";

import { CheckCircle2, Layers, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { STATUS_LABEL, type EmailResult, type EmailStatus } from "@/lib/validation-types";

export interface LiveProgress {
  done: number;
  total: number;
  /** Fase actual: capas 1-2 (rÃ¡pida) o capa 3 (SMTP por lotes) */
  phase: "layers12" | "smtp" | "ea";
  /** Mensaje de estado, p. ej. "Lote 3 de 20 Â· pausa de 10 s" */
  statusText?: string;
  /** Ãšltimos correos procesados (el mÃ¡s reciente primero) */
  recent: EmailResult[];
  /** CuÃ¡ntos correos se resolvieron en cada capa [1, 2, 3] */
  layerCounts: [number, number, number, number];
  valid: number;
  invalid: number;
  risky: number;
}

const BADGE: Partial<Record<EmailStatus, string>> = {
  valid: "bg-green-100 text-green-700",
  invalid_excluded: "bg-slate-200 text-slate-700",
  risky_typo: "bg-amber-100 text-amber-700",
  risky_role: "bg-amber-100 text-amber-700",
  risky_catchall: "bg-amber-100 text-amber-700",
};

export function ValidationProgressModal({
  progress,
  fileName,
  onCancel,
}: {
  progress: LiveProgress;
  fileName: string;
  onCancel: () => void;
}) {
  const { done, total, phase, recent, layerCounts } = progress;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const finished = total > 0 && done >= total;

  const layers = [
    { n: 1, name: "Sintaxis y listas", hint: "Formato, desechables, tipeo, exclusiÃ³n", active: true },
    { n: 2, name: "Dominio (MX)", hint: "Registros DNS y cuentas genÃ©ricas", active: true },
    {
      n: 3, name: "BuzÃ³n (SMTP)", active: phase === "smtp",
      hint: phase === "smtp" ? "Consulta al servidor de correo, por lotes" : "Opcional, por lotes",
    },
    {
      n: 4, name: "EmailAwesome", active: phase === "ea",
      hint: phase === "ea" ? "VerificaciÃ³n externa por API" : "Opcional, con crÃ©ditos",
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Progreso de validaciÃ³n"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-hidden rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              {finished ? (
                <CheckCircle2 className="text-green-600" size={20} />
              ) : (
                <Loader2 className="animate-spin text-indigo-600" size={20} />
              )}
              {finished && progress.phase === "layers12"
                ? "Finalizando..."
                : progress.phase === "smtp"
                  ? "Verificando buzones por SMTP (capa 3)"
                  : progress.phase === "ea"
                    ? "Verificando con EmailAwesome (capa 4)"
                    : "Validando correos (capas 1 y 2)"}
            </h2>
            <p className="truncate text-sm text-slate-500">{fileName}</p>
          </div>
          <button
            onClick={onCancel}
            className="rounded-lg p-1 text-slate-500 hover:bg-slate-100"
            aria-label="Cancelar validaciÃ³n"
          >
            <X size={20} />
          </button>
        </div>

        {/* Barra de progreso */}
        <div>
          <div className="mb-1 flex justify-between text-sm">
            <span className="font-medium">{pct}%</span>
            <span className="text-slate-500">
              {done.toLocaleString()} de {total.toLocaleString()}
            </span>
          </div>
          <div
            className="h-3 w-full overflow-hidden rounded-full bg-slate-200"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-indigo-600 transition-all duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          {progress.statusText && (
            <p className="mt-1 text-xs text-slate-500">{progress.statusText}</p>
          )}
        </div>

        {/* Contadores */}
        <div className="grid grid-cols-3 gap-2 text-center text-sm">
          <div className="rounded-lg bg-green-50 p-2 text-green-700">
            <p className="text-lg font-semibold">{progress.valid}</p>VÃ¡lidos
          </div>
          <div className="rounded-lg bg-red-50 p-2 text-red-700">
            <p className="text-lg font-semibold">{progress.invalid}</p>InvÃ¡lidos
          </div>
          <div className="rounded-lg bg-amber-50 p-2 text-amber-700">
            <p className="text-lg font-semibold">{progress.risky}</p>Riesgo
          </div>
        </div>

        {/* Las 3 capas */}
        <div className="grid gap-2 sm:grid-cols-2">
          {layers.map((l) => (
            <div
              key={l.n}
              className={`rounded-lg border p-2 text-xs ${
                l.active ? "border-slate-200" : "border-dashed border-slate-200 opacity-50"
              }`}
            >
              <p className="flex items-center gap-1 font-medium text-slate-700">
                <Layers size={12} /> Capa {l.n}: {l.name}
              </p>
              <p className="text-slate-500">{l.hint}</p>
              <p className="mt-1 text-sm font-semibold">{layerCounts[l.n - 1]} resueltos</p>
            </div>
          ))}
        </div>

        {/* Correos en vivo */}
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200">
          <ul className="divide-y divide-slate-100 text-sm">
            {recent.length === 0 && (
              <li className="px-3 py-4 text-center text-slate-400">Preparando...</li>
            )}
            {recent.map((r, i) => (
              <li key={`${r.email}-${i}`} className="flex items-center justify-between gap-2 px-3 py-1.5">
                <span className="truncate">{r.email}</span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                    BADGE[r.status] ?? "bg-red-100 text-red-700"
                  }`}
                >
                  {STATUS_LABEL[r.status]}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex justify-end">
          <Button variant="secondary" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </div>
    </div>
  );
}
