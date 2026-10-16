import { NextResponse } from "next/server";
import { eaConfigured } from "@/lib/emailawesome";

export const runtime = "nodejs";
// Sin esto Next resolvería la ruta al compilar y devolvería siempre el mismo valor
export const dynamic = "force-dynamic";

// Indica si hay clave de EmailAwesome configurada (nunca devuelve la clave).
export async function GET() {
  return NextResponse.json({ configured: eaConfigured() });
}
