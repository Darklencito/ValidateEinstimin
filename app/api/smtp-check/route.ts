import { NextResponse } from "next/server";
import { checkConnectivity } from "@/lib/smtp";

export const runtime = "nodejs";
// Sin esto Next resolvería la ruta al compilar y devolvería siempre el mismo resultado
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Prueba si desde este servidor (o desde cada proxy configurado) se llega al puerto 25.
export async function GET() {
  const results = await checkConnectivity();
  return NextResponse.json({ results });
}
