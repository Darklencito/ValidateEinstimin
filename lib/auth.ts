import { SignJWT, jwtVerify } from "jose";

// Nombre de la cookie de sesión
export const COOKIE_NAME = "csvm_token";
// Duración de la sesión: 8 horas
export const SESSION_SECONDS = 60 * 60 * 8;

// Solo usa APIs compatibles con edge runtime (jose usa Web Crypto),
// por eso este archivo puede importarse desde middleware.ts.
function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("JWT_SECRET no configurado (mínimo 16 caracteres)");
  }
  return new TextEncoder().encode(secret);
}

export async function signToken(username: string): Promise<string> {
  return new SignJWT({ username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_SECONDS}s`)
    .sign(getSecret());
}

/** Devuelve el payload si el token es válido, o null si no. */
export async function verifyToken(
  token?: string
): Promise<{ username: string } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return typeof payload.username === "string"
      ? { username: payload.username }
      : null;
  } catch {
    return null;
  }
}

export const cookieOptions = {
  httpOnly: true,
  // Secure solo en producción para poder probar en http://localhost
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
};
