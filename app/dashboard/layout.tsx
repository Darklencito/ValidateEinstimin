import { cookies } from "next/headers";
import { COOKIE_NAME, verifyToken } from "@/lib/auth";
import { Sidebar } from "@/components/Sidebar";

// Se renderiza siempre en el servidor para leer la cookie de sesión
export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await verifyToken(cookies().get(COOKIE_NAME)?.value);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50/40">
      <Sidebar username={session?.username ?? "usuario"} />
      <main className="px-4 pb-10 pt-20 md:ml-64 md:px-8">{children}</main>
    </div>
  );
}
