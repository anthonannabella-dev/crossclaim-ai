/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // C-0008-A: the web app talks to apps/api over HTTP only. It never imports
  // Prisma, the database, or the storage adapter (see README).
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.CROSSCLAIM_API_URL ?? 'http://127.0.0.1:3000'}/:path*`,
      },
    ];
  },
};

export default nextConfig;
