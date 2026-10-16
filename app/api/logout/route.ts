import { NextResponse } from "next/server";
import { COOKIE_NAME, cookieOptions } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  // Eliminar la cookie = maxAge 0
  res.cookies.set(COOKIE_NAME, "", { ...cookieOptions, maxAge: 0 });
  return res;
}
