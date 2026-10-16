// Tipos compartidos entre cliente y servidor (sin imports de Node)
export type EmailStatus =
  | "valid"
  | "invalid_format"
  | "invalid_mx"
  | "invalid_mailbox"
  | "invalid_disposable"
  | "invalid_excluded"
  | "risky_typo"
  | "risky_role"
  | "risky_catchall";

export const STATUS_LABEL: Record<EmailStatus, string> = {
  valid: "Válido",
  invalid_format: "Inválido (formato)",
  invalid_mx: "Inválido (sin MX)",
  invalid_mailbox: "Inválido (buzón no existe)",
  invalid_disposable: "Inválido (correo desechable)",
  invalid_excluded: "Excluido (lista de bajas/rebotes)",
  risky_typo: "Riesgo (posible error de tipeo)",
  risky_role: "Riesgo (cuenta genérica)",
  risky_catchall: "Riesgo (catch-all)",
};

export const ALL_STATUSES = Object.keys(STATUS_LABEL) as EmailStatus[];

export function emptySummary(): Record<EmailStatus, number> {
  return Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<EmailStatus, number>;
}

export interface EmailResult {
  email: string;
  status: EmailStatus;
  reason: string;
  /** Capa en la que se decidió: 1 local, 2 DNS/MX, 3 SMTP */
  layer?: 1 | 2 | 3;
  /** true si el servidor SMTP dio una respuesta concluyente sobre este correo */
  confirmed?: boolean;
  /** Celda original del CSV (solo si traía varios correos) */
  source?: string;
  /** Identificador de la celda de origen; los correos de una misma celda comparten grupo */
  group?: number;
}

export interface ValidationResponse {
  total: number;
  summary: Record<EmailStatus, number>;
  results: EmailResult[];
  /** Celdas que contenían más de un correo */
  multiCells: number;
  /** Cantidad de correos cargados en la lista de exclusión */
  excludedListSize: number;
  notice?: string;
}

/** Eventos que envía /api/validate-csv como NDJSON (una línea JSON por evento) */
export type StreamEvent =
  | { type: "start"; total: number }
  | { type: "item"; index: number; result: EmailResult }
  | { type: "done"; meta: Omit<ValidationResponse, "results" | "summary" | "total"> };

/** Respuesta de /api/smtp-batch */
export interface SmtpBatchResponse {
  results: { email: string; status: EmailStatus; reason: string; confirmed: boolean }[];
  connectFailed: number;
  throttled: number;
  via: string;
}

