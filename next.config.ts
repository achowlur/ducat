import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module (better-sqlite3) and the generated Prisma client must not
  // be bundled by webpack — load them from node_modules at runtime.
  serverExternalPackages: ["better-sqlite3", "@prisma/adapter-better-sqlite3"],
};

export default nextConfig;
