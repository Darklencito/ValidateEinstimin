import { NextRequest, NextResponse } from "next/server";
import { isValidFormat } from "@/lib/email-validation";
import { eaConfigured, verifyWithEa } from "@/lib/emailawesome";
import { emailvalConfigured, verifyWithEmailval } from "@/lib/emailval";

export const runtime = "nodejs";
export const maxDuration = 120;

// Capa 4: verifica con un proveedor externo un lote pequeño de correos.
//   provider "emailawesome": lotes de hasta 25; admite `resume` (validaciones ya creadas, sin recobrar).
//   provider "emailval":     lotes de hasta 100; respuesta síncrona.
export async function POST(req: NextRequest) {
  let body: { provider?: unknown; emails?: unknown; resume?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Solicitud inválida" }, { status: 400 });
  }

  const provider = body.provider === "emailval" ? "emailval" : "emailawesome";

  if (provider === "emailawesome" && !eaConfigured()) {
    return NextResponse.json({ error: "Falta la variable de entorno EMAILAWESOME_API_KEY en el servidor." }, { status: 503 });
  }
  if (provider === "emailval" && !emailvalConfigured()) {
    return NextResponse.json({ error: "Falta la variable de entorno EMAILVAL_API_KEY en el servidor." }, { status: 503 });
  }

  const emails = (Array.isArray(body.emails) ? body.emails : [])
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim())
    .filter(isValidFormat);

  if (provider === "emailval") {
    if (emails.length === 0) return NextResponse.json({ error: "Lote vacío" }, { status: 400 });
    if (emails.length > 100) return NextResponse.json({ error: "Máximo 100 correos por lote" }, { status: 413 });
    return NextResponse.json(await verifyWithEmailval(emails));
  }

  const resume = (Array.isArray(body.resume) ? body.resume : []).filter(
    (r): r is { email: string; id: string } =>
      !!r && typeof (r as { email?: unknown }).email === "string" && typeof (r as { id?: unknown }).id === "string"
  );
  if (emails.length + resume.length === 0) {
    return NextResponse.json({ error: "Lote vacío" }, { status: 400 });
  }
  if (emails.length + resume.length > 25) {
    return NextResponse.json({ error: "Máximo 25 correos por lote" }, { status: 413 });
  }
  return NextResponse.json(await verifyWithEa(emails, resume));
}
