import { NextRequest, NextResponse } from "next/server";
import { isValidFormat } from "@/lib/email-validation";
import { eaConfigured, verifyWithEa } from "@/lib/emailawesome";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BATCH = 25;

// Capa 4: verifica con EmailAwesome un lote pequeño de correos (o reanuda validaciones ya creadas).
export async function POST(req: NextRequest) {
  if (!eaConfigured()) {
    return NextResponse.json(
      { error: "Falta la variable de entorno EMAILAWESOME_API_KEY en el servidor." },
      { status: 503 }
    );
  }

  let body: { emails?: unknown; resume?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Solicitud inválida" }, { status: 400 });
  }

  const emails = (Array.isArray(body.emails) ? body.emails : [])
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim())
    .filter(isValidFormat);

  const resume = (Array.isArray(body.resume) ? body.resume : []).filter(
    (r): r is { email: string; id: string } =>
      !!r && typeof (r as { email?: unknown }).email === "string" && typeof (r as { id?: unknown }).id === "string"
  );

  if (emails.length + resume.length === 0) {
    return NextResponse.json({ error: "Lote vacío" }, { status: 400 });
  }
  if (emails.length + resume.length > MAX_BATCH) {
    return NextResponse.json({ error: `Máximo ${MAX_BATCH} correos por lote` }, { status: 413 });
  }

  return NextResponse.json(await verifyWithEa(emails, resume));
}
