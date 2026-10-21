import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import type { ProcessedFileRecord } from "@/lib/storage";
import type { EmailResult } from "@/lib/validation-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), ".data");
const FILES_PATH = path.join(DATA_DIR, "processed-files.json");
const CACHE_PATH = path.join(DATA_DIR, "email-cache.json");
const MAX_STORED_FILES = 30;

type CachedEmailItem = Pick<EmailResult, "status" | "reason" | "layer" | "confirmed"> & {
  updatedAt: number;
};

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readFilesStore(): Promise<ProcessedFileRecord[]> {
  try {
    const raw = await fs.readFile(FILES_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeFilesStore(files: ProcessedFileRecord[]): Promise<void> {
  await ensureDir();
  files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const trimmed = files.slice(0, MAX_STORED_FILES);
  const tmp = `${FILES_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(trimmed), "utf-8");
  await fs.rename(tmp, FILES_PATH);
}

async function readEmailCache(): Promise<Record<string, CachedEmailItem>> {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeEmailCache(cache: Record<string, CachedEmailItem>): Promise<void> {
  await ensureDir();
  const tmp = `${CACHE_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache), "utf-8");
  await fs.rename(tmp, CACHE_PATH);
}

function mergeResultsIntoCache(
  cache: Record<string, CachedEmailItem>,
  results: EmailResult[]
): boolean {
  let changed = false;
  const now = Date.now();
  for (const r of results) {
    if ((r.layer && r.layer >= 3) || r.confirmed) {
      cache[r.email.toLowerCase()] = {
        status: r.status,
        reason: r.reason,
        layer: r.layer,
        confirmed: r.confirmed,
        updatedAt: now,
      };
      changed = true;
    }
  }
  return changed;
}

export async function GET(req: NextRequest) {
  const hash = req.nextUrl.searchParams.get("hash");
  const files = await readFilesStore();
  files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (hash) {
    const match = files.find((f) => f.fileHash === hash) ?? null;
    return NextResponse.json({ match }, { headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json({ files }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const action = body.action as string;

  if (action === "save_file") {
    const record = body.record as ProcessedFileRecord | undefined;
    if (!record || !record.id || !record.fileName) {
      return NextResponse.json({ error: "Falta record válido" }, { status: 400 });
    }
    const files = await readFilesStore();
    const idx = files.findIndex((f) => f.id === record.id || (record.fileHash && f.fileHash === record.fileHash));
    if (idx >= 0) {
      // Conservar el mismo ID si coincidía por hash para no duplicar tarjetas del mismo archivo
      files[idx] = { ...record, id: files[idx].id };
    } else {
      files.unshift(record);
    }
    await writeFilesStore(files);

    if (Array.isArray(record.data?.results)) {
      const cache = await readEmailCache();
      if (mergeResultsIntoCache(cache, record.data.results)) {
        await writeEmailCache(cache);
      }
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "sync_local") {
    const localFiles = (body.files as ProcessedFileRecord[]) ?? [];
    if (!Array.isArray(localFiles) || localFiles.length === 0) {
      const current = await readFilesStore();
      return NextResponse.json({ files: current });
    }
    const serverFiles = await readFilesStore();
    const byIdOrHash = new Map<string, ProcessedFileRecord>();
    for (const sf of serverFiles) {
      byIdOrHash.set(sf.fileHash || sf.id, sf);
    }
    let changed = false;
    const cache = await readEmailCache();
    let cacheChanged = false;

    for (const lf of localFiles) {
      if (!lf || !lf.id) continue;
      const key = lf.fileHash || lf.id;
      const existing = byIdOrHash.get(key);
      if (!existing || lf.updatedAt > existing.updatedAt) {
        byIdOrHash.set(key, lf);
        changed = true;
      }
      if (Array.isArray(lf.data?.results) && mergeResultsIntoCache(cache, lf.data.results)) {
        cacheChanged = true;
      }
    }
    const merged = Array.from(byIdOrHash.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
    if (changed) await writeFilesStore(merged);
    if (cacheChanged) await writeEmailCache(cache);
    return NextResponse.json({ files: merged.slice(0, MAX_STORED_FILES) });
  }

  if (action === "cache_emails") {
    const results = (body.results as EmailResult[]) ?? [];
    if (Array.isArray(results) && results.length > 0) {
      const cache = await readEmailCache();
      if (mergeResultsIntoCache(cache, results)) {
        await writeEmailCache(cache);
      }
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "get_cached_emails") {
    const emails = (body.emails as string[]) ?? [];
    const cache = await readEmailCache();
    const out: Record<string, CachedEmailItem> = {};
    for (const raw of emails) {
      const k = String(raw).toLowerCase();
      if (cache[k]) out[k] = cache[k];
    }
    return NextResponse.json({ cached: out });
  }

  return NextResponse.json({ error: "Acción desconocida" }, { status: 400 });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Falta id" }, { status: 400 });
  const files = await readFilesStore();
  const filtered = files.filter((f) => f.id !== id);
  await writeFilesStore(filtered);
  return NextResponse.json({ ok: true });
}
