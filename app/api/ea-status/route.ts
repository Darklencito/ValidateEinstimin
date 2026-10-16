import { NextResponse } from "next/server";
import { eaConfigured, getBalance } from "@/lib/emailawesome";

export const runtime = "nodejs";
// Sin esto Next resolvería la ruta al compilar y devolvería siempre el mismo valor
export const dynamic = "force-dynamic";

// Indica si hay clave de EmailAwesome y cuántos créditos quedan (nunca devuelve la clave).
export async function GET() {
  const configured = eaConfigured();
  return NextResponse.json({ configured, balance: configured ? await getBalance() : null });
}
