import { NextResponse } from "next/server";
import { providersStatus } from "@/lib/verifiers";

export const runtime = "nodejs";
// Sin esto Next resolvería la ruta al compilar y devolvería siempre el mismo valor
export const dynamic = "force-dynamic";

// Qué proveedores externos hay configurados y su saldo (nunca devuelve las claves).
export async function GET() {
  return NextResponse.json(await providersStatus());
}
