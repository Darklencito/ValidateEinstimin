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
    <div className="min-h-screen">
      <Sidebar username={session?.username ?? "usuario"} />
      <main className="px-4 pb-10 pt-20 md:ml-60 md:px-8">{children}</main>
    </div>
  );
}
