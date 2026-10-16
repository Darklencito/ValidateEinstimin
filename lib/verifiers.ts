import { eaConfigured, getBalance as eaBalance } from "./emailawesome";
import { EMAILVAL_SKIP_REGEX, emailvalConfigured } from "./emailval";
import type { VerifiersStatus } from "./validation-types";

// Solo servidor. Registro de proveedores de verificación externa (capa 4).

export const PROVIDER_IDS = ["emailawesome", "emailval"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Orden en que se usan los proveedores en modo automático: si uno se queda sin créditos,
 * se continúa con el siguiente. Se cambia con VERIFIER_ORDER (p. ej. "emailval,emailawesome").
 */
export function providerOrder(): ProviderId[] {
  const raw = (process.env.VERIFIER_ORDER || "").split(",").map((s) => s.trim());
  const picked = raw.filter((s): s is ProviderId => (PROVIDER_IDS as readonly string[]).includes(s));
  const all = [...new Set([...picked, ...PROVIDER_IDS])];
  return all as ProviderId[];
}

export async function providersStatus(): Promise<VerifiersStatus> {
  const eaOn = eaConfigured();
  const evOn = emailvalConfigured();
  return {
    order: providerOrder(),
    providers: [
      {
        id: "emailawesome",
        name: "EmailAwesome",
        configured: eaOn,
        balance: eaOn ? await eaBalance() : null,
        costPerEmail: null, // se cobra en créditos de tu plan
        unit: "crédito",
        skipDomainRegex: null,
        maxBatch: 20,
      },
      {
        id: "emailval",
        name: "emailval",
        configured: evOn,
        balance: null, // no tiene consulta de saldo: se cobra por uso a fin de mes
        costPerEmail: 0.0008,
        unit: "correo",
        skipDomainRegex: EMAILVAL_SKIP_REGEX,
        maxBatch: 100,
      },
    ],
  };
}
