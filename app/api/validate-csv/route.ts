import { NextRequest, NextResponse } from "next/server";
import { parseCsvText } from "@/lib/csv";
import { mapLimit, validateEmail } from "@/lib/email-validation";
import type { StreamEvent } from "@/lib/validation-types";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_EMAILS = 10000;

/** Busca la columna de correos: por nombre, o la primera que contenga "@". */
function detectEmailColumn(columns: string[], rows: Record<string, string>[]): string {
  const byName = columns.find((c) => /e-?mail|correo|mail/i.test(c));
  if (byName) return byName;
  const byContent = columns.find((c) => rows.slice(0, 20).some((r) => r[c]?.includes("@")));
  return byContent ?? columns[0];
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Solicitud inválida" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Falta el archivo CSV" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "El archivo supera los 5 MB" }, { status: 413 });
  }

  const { rows, columns } = parseCsvText(await file.text());
  if (columns.length === 0 || rows.length === 0) {
    return NextResponse.json({ error: "El CSV está vacío o no tiene cabecera" }, { status: 400 });
  }

  const col = detectEmailColumn(columns, rows);
  // Elimina vacíos y duplicados exactos (insensible a mayúsculas)
  const seen = new Set<string>();
  const entries: { email: string; source?: string; group?: number }[] = [];
  let multiCells = 0;
  let groupId = 0;
  for (const r of rows) {
    const cell = (r[col] ?? "").trim();
    if (!cell) continue;
    // Una celda puede traer varios correos: "a@x.com / b@x.com", "a@x.com; b@x.com"...
    const parts = cell.split(/[\s/;,|]+/).filter(Boolean);
    const isMulti = parts.filter((p) => p.includes("@")).length > 1;
    const items = isMulti ? parts : [cell];
    if (isMulti) multiCells++;
    const group = groupId++;
    for (const v of items) {
      if (seen.has(v.toLowerCase())) continue;
      seen.add(v.toLowerCase());
      entries.push(isMulti ? { email: v, source: cell, group } : { email: v });
    }
  }
  if (entries.length === 0) {
    return NextResponse.json({ error: "No se encontraron correos en el CSV" }, { status: 400 });
  }
  if (entries.length > MAX_EMAILS) {
    return NextResponse.json(
      { error: `Máximo ${MAX_EMAILS} correos por archivo (tiene ${entries.length})` },
      { status: 413 }
    );
  }

  // Lista de exclusión opcional (bloqueados / rebotados de Brevo): extrae todos los correos del archivo
  const excluded = new Set<string>();
  const excludeFile = form.get("exclude");
  if (excludeFile instanceof File && excludeFile.size > 0) {
    if (excludeFile.size > MAX_BYTES) {
      return NextResponse.json({ error: "La lista de exclusión supera los 5 MB" }, { status: 413 });
    }
    const found = (await excludeFile.text()).toLowerCase().match(/[^\s,;"'<>()]+@[^\s,;"'<>()]+/g);
    found?.forEach((e) => excluded.add(e.replace(/[.]+$/, "")));
  }

  // Respuesta en streaming (NDJSON): una línea JSON por evento, para mostrar el progreso en vivo
  const encoder = new TextEncoder();
  const abort = { aborted: false };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: StreamEvent) => {
        if (!abort.aborted) controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      };
      try {
        send({ type: "start", total: entries.length });
        await mapLimit(
          entries,
          20,
          async (e) => ({
            ...(await validateEmail(e.email, { excluded })),
            source: e.source,
            group: e.group,
          }),
          (result, index) => send({ type: "item", index, result }),
          abort
        );
        send({
          type: "done",
          meta: { multiCells, excludedListSize: excluded.size },
        });
      } finally {
        if (!abort.aborted) controller.close();
      }
    },
    // El cliente canceló (cerró el modal): dejamos de procesar
    cancel() {
      abort.aborted = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Evita que nginx/proxies acumulen la respuesta antes de enviarla
      "X-Accel-Buffering": "no",
    },
  });
}
