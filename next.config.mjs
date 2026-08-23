/** @type {import('next').NextConfig} */
const nextConfig = {
  // pg и pdf-parse — нативные/файловые Node-модули, их не нужно (и нельзя
  // корректно) тащить через webpack-бандлер серверных компонентов.
  experimental: {
    serverComponentsExternalPackages: ["pg", "pdf-parse"],
  },
};

export default nextConfig;
