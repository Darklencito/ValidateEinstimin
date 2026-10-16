/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Evita que webpack empaquete módulos nativos de Node usados solo en el servidor
  experimental: {
    serverComponentsExternalPackages: ["bcryptjs", "disposable-email-domains"],
  },
};

module.exports = nextConfig;
