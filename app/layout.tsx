import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CSV Manager",
  description: "Valida y construye archivos CSV",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
