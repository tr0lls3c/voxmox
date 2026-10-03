import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow Cloud Agent / proxy hosts to load the Turbopack/Webpack HMR client.
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "*.cursor.sh",
    "*.cursorusercontent.com",
  ],
};

export default nextConfig;
