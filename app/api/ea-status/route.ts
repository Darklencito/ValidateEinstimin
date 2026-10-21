import { NextResponse } from "next/server";
import { providersStatus } from "@/lib/verifiers";

export const runtime = "nodejs";
// Sin esto Next resolvería la ruta al compilar o cachearía el fetch externo
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

// Qué proveedores externos hay configurados y su saldo en vivo (nunca devuelve las claves).
export async function GET() {
  const status = await providersStatus();
  return NextResponse.json(status, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}
