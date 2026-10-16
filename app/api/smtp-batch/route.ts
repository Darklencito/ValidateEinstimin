import { NextRequest, NextResponse } from "next/server";
import { isValidFormat } from "@/lib/email-validation";
import { verifyBatch } from "@/lib/smtp";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BATCH = 300; // el cliente envía lotes pequeños; este es solo un tope de seguridad

// Capa 3: verifica por SMTP un lote de correos que ya pasaron las capas 1 y 2.
export async function POST(req: NextRequest) {
  let body: { emails?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Solicitud inválida" }, { status: 400 });
  }

  const emails = Array.isArray(body.emails) ? body.emails.filter((e): e is string => typeof e === "string") : [];
  if (emails.length === 0) {
    return NextResponse.json({ error: "Lote vacío" }, { status: 400 });
  }
  if (emails.length > MAX_BATCH) {
    return NextResponse.json({ error: `Máximo ${MAX_BATCH} correos por lote` }, { status: 413 });
  }
  const valid = emails.map((e) => e.trim()).filter(isValidFormat);

  // Si el cliente cancela la petición, dejamos de consultar
  const stop = { aborted: false };
  req.signal.addEventListener("abort", () => (stop.aborted = true));

  const outcome = await verifyBatch(valid, stop);
  return NextResponse.json(outcome);
}
