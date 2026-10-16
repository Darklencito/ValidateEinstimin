"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  Coins, FileSpreadsheet, LogOut, MailCheck, Menu, RefreshCw, Table2, TriangleAlert, X,
} from "lucide-react";
import type { VerifiersStatus } from "@/lib/validation-types";

const links = [
  { href: "/dashboard/validador", label: "Validador", hint: "Limpia tus correos", icon: MailCheck },
  { href: "/dashboard/constructor", label: "Constructor", hint: "Arma tu CSV", icon: Table2 },
];

const fmt = (n: number) => n.toLocaleString("es");

/** Tarjeta de créditos: se actualiza cada minuto y cuando el validador termina de gastar. */
function CreditsCard() {
  const [status, setStatus] = useState<VerifiersStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/ea-status", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setStatus(await res.json());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    // El validador avisa con este evento cuando termina una verificación externa
    window.addEventListener("credits:refresh", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("credits:refresh", load);
    };
  }, [load]);

  const configured = status?.providers.filter((p) => p.configured) ?? [];

  return (
    <div className="rounded-2xl bg-white/5 p-3 ring-1 ring-white/10">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <Coins size={14} className="text-amber-300" /> Créditos
        </span>
        <button
          onClick={load}
          disabled={refreshing}
          className="rounded-md p-1 text-slate-400 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
          aria-label="Actualizar créditos"
          title="Actualizar"
        >
          <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
        </button>
      </div>

      {status === null && !failed && <div className="h-14 animate-pulse rounded-xl bg-white/10" />}

      {failed && status === null && (
        <p className="flex items-center gap-1.5 text-xs text-amber-300">
          <TriangleAlert size={13} /> No se pudo consultar
        </p>
      )}

      {status !== null && configured.length === 0 && (
        <p className="text-xs leading-relaxed text-slate-400">
          Sin proveedor externo configurado. Añade <code className="text-slate-300">EMAILAWESOME_API_KEY</code> para
          ver aquí tus créditos.
        </p>
      )}

      <ul className="space-y-2">
        {configured.map((p) => {
          const b = p.balance;
          const tone =
            b === null ? "text-sky-300" : b <= 0 ? "text-red-400" : b <= 100 ? "text-amber-300" : "text-emerald-300";
          return (
            <li key={p.id} className="rounded-xl bg-black/20 p-2.5">
              <p className="text-[11px] font-medium text-slate-400">{p.name}</p>
              {b !== null ? (
                <>
                  <p className={`text-2xl font-bold leading-tight ${tone}`}>{fmt(b)}</p>
                  <p className="text-xs text-slate-300">
                    {b <= 0 ? "Sin créditos" : b <= 100 ? "Te quedan pocos créditos" : `Te quedan ${fmt(b)} créditos`}
                  </p>
                </>
              ) : (
                <>
                  <p className={`text-sm font-semibold ${tone}`}>Pago por uso</p>
                  <p className="text-xs text-slate-300">
                    {p.costPerEmail !== null ? `≈ US$ ${p.costPerEmail} por correo` : "Sin saldo consultable"}
                  </p>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Sidebar({ username }: { username: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const initial = (username.trim()[0] ?? "U").toUpperCase();

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <>
      {/* Cabecera: en móvil muestra el botón de menú */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-slate-200/80 bg-white/80 px-4 backdrop-blur md:left-64">
        <button
          className="rounded-lg p-2 hover:bg-slate-100 md:hidden"
          onClick={() => setOpen(!open)}
          aria-label="Abrir menú"
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
        <div className="ml-auto flex items-center gap-2.5">
          <span className="hidden text-sm text-slate-500 sm:inline">Sesión de</span>
          <span className="text-sm font-semibold text-slate-900">{username}</span>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-semibold text-white shadow-sm">
            {initial}
          </span>
        </div>
      </header>

      {/* Fondo oscuro en móvil al abrir el menú */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/50 backdrop-blur-sm md:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col gap-5 overflow-y-auto bg-gradient-to-b from-slate-900 via-slate-900 to-indigo-950 p-4 text-slate-200 shadow-xl transition-transform md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Marca */}
        <div className="flex items-center gap-3 px-1 pt-1">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-900/40">
            <FileSpreadsheet size={20} className="text-white" />
          </span>
          <div className="leading-tight">
            <p className="text-base font-semibold text-white">CSV Manager</p>
            <p className="text-xs text-slate-400">Correos y clientes</p>
          </div>
        </div>

        {/* Navegación */}
        <nav className="space-y-1">
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Herramientas</p>
          {links.map(({ href, label, hint, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 transition ${
                  active ? "bg-white/10 text-white" : "text-slate-300 hover:bg-white/5 hover:text-white"
                }`}
              >
                {active && <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r-full bg-indigo-400" />}
                <span
                  className={`flex h-8 w-8 items-center justify-center rounded-lg transition ${
                    active ? "bg-indigo-500/30 text-indigo-200" : "bg-white/5 text-slate-400 group-hover:text-slate-200"
                  }`}
                >
                  <Icon size={17} />
                </span>
                <span className="leading-tight">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-[11px] text-slate-400">{hint}</span>
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto space-y-3">
          <CreditsCard />
          <button
            onClick={logout}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-red-300 transition hover:bg-red-500/10 hover:text-red-200"
          >
            <LogOut size={18} /> Cerrar sesión
          </button>
        </div>
      </aside>
    </>
  );
}
