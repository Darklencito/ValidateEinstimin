// Almacenamiento en el navegador (IndexedDB + sessionStorage) para:
// 1. Historial de archivos CSV procesados y su estado completo
// 2. Huella SHA-256 de cada CSV para detectar si ya fue procesado
// 3. Caché de correos ya verificados (especialmente SMTP y Capa 4 con costo)
// 4. Envío directo de datos limpios del Validador al Constructor

import type { Row } from "./csv";
import type { EmailResult, ValidationResponse } from "./validation-types";

export type LogLevel = "info" | "success" | "warn" | "error";

export interface LogEntry {
  id: string;
  time: string; // HH:mm:ss
  level: LogLevel;
  step: string; // "Archivo" | "Capa 1-2" | "SMTP" | "Externa" | "Exportación" | "Sistema"
  message: string;
}

export interface ProcessedFileRecord {
  id: string;
  fileHash: string;
  fileName: string;
  fileSize: number;
  processedAt: string; // ISO
  updatedAt: string; // ISO
  data: ValidationResponse;
  rawColumns: string[];
  rawRows: Row[];
  emailColumn: string;
  logs: LogEntry[];
}

export interface BuilderDraft {
  fileName: string;
  columns: string[];
  rows: Row[];
  fromValidator?: boolean;
}

const DB_NAME = "instimin_csv_db";
const DB_VERSION = 1;
const STORE_FILES = "processed_files";
const STORE_EMAIL_CACHE = "email_cache";
const DRAFT_KEY = "instimin_builder_draft";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      return reject(new Error("IndexedDB no disponible"));
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        const s = db.createObjectStore(STORE_FILES, { keyPath: "id" });
        s.createIndex("by_hash", "fileHash", { unique: false });
        s.createIndex("by_updated", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_EMAIL_CACHE)) {
        db.createObjectStore(STORE_EMAIL_CACHE, { keyPath: "email" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Calcula el hash SHA-256 del contenido normalizado del CSV. */
export async function computeCsvHash(text: string): Promise<string> {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const buf = new TextEncoder().encode(normalized);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Fallback simple si crypto.subtle no está disponible (ej. HTTP sin localhost)
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv_${(h >>> 0).toString(16)}_${normalized.length}`;
}

/** Crea una entrada de log con marca de tiempo actual. */
export function makeLog(
  level: LogLevel,
  step: string,
  message: string
): LogEntry {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    time,
    level,
    step,
    message,
  };
}

/** Lista todos los archivos procesados ordenados del más reciente al más antiguo. */
export async function listProcessedFiles(): Promise<ProcessedFileRecord[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FILES, "readonly");
      const req = tx.objectStore(STORE_FILES).getAll();
      req.onsuccess = () => {
        const items = (req.result as ProcessedFileRecord[]) ?? [];
        items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

/** Busca si un archivo con el mismo hash ya fue procesado antes. */
export async function findProcessedByHash(
  fileHash: string
): Promise<ProcessedFileRecord | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FILES, "readonly");
      const idx = tx.objectStore(STORE_FILES).index("by_hash");
      const req = idx.getAll(fileHash);
      req.onsuccess = () => {
        const matches = (req.result as ProcessedFileRecord[]) ?? [];
        matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        resolve(matches[0] ?? null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** Guarda o actualiza un archivo procesado en el historial (conserva máximo 25). */
export async function saveProcessedFile(
  record: ProcessedFileRecord
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_FILES, "readwrite");
      tx.objectStore(STORE_FILES).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // Limpiar antiguos si hay más de 25
    const all = await listProcessedFiles();
    if (all.length > 25) {
      const toDelete = all.slice(25);
      for (const old of toDelete) {
        await deleteProcessedFile(old.id);
      }
    }
  } catch {
    // Ignorar errores de cuota
  }
}

/** Elimina un archivo procesado del historial. */
export async function deleteProcessedFile(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_FILES, "readwrite");
      tx.objectStore(STORE_FILES).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

/** Guarda resultados de correos (especialmente capa 3 y 4) en la caché global local. */
export async function cacheEmailResults(results: EmailResult[]): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_EMAIL_CACHE, "readwrite");
      const store = tx.objectStore(STORE_EMAIL_CACHE);
      const now = Date.now();
      for (const r of results) {
        // Guardamos sobre todo los que llegaron a capa 3 o 4, o fueron confirmados
        if ((r.layer && r.layer >= 3) || r.confirmed) {
          store.put({
            email: r.email.toLowerCase(),
            status: r.status,
            reason: r.reason,
            layer: r.layer,
            confirmed: r.confirmed,
            updatedAt: now,
          });
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

/** Consulta resultados cacheados previamente (capa 3 o 4) para no gastar créditos ni SMTP dos veces. */
export async function getCachedEmails(
  emails: string[]
): Promise<Map<string, Pick<EmailResult, "status" | "reason" | "layer" | "confirmed">>> {
  const map = new Map<string, Pick<EmailResult, "status" | "reason" | "layer" | "confirmed">>();
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_EMAIL_CACHE, "readonly");
      const store = tx.objectStore(STORE_EMAIL_CACHE);
      let remaining = emails.length;
      if (remaining === 0) return resolve();
      for (const raw of emails) {
        const key = raw.toLowerCase();
        const req = store.get(key);
        req.onsuccess = () => {
          if (req.result) {
            map.set(key, {
              status: req.result.status,
              reason: req.result.reason,
              layer: req.result.layer,
              confirmed: req.result.confirmed,
            });
          }
          if (--remaining === 0) resolve();
        };
        req.onerror = () => {
          if (--remaining === 0) resolve();
        };
      }
    });
  } catch {
    // ignore
  }
  return map;
}

/** Guarda un borrador temporal para abrir los datos directamente en el Constructor. */
export function saveBuilderDraft(draft: BuilderDraft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // ignore
  }
}

/** Lee y limpia el borrador enviado desde el Validador al Constructor. */
export function consumeBuilderDraft(): BuilderDraft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(DRAFT_KEY);
    return JSON.parse(raw) as BuilderDraft;
  } catch {
    return null;
  }
}
