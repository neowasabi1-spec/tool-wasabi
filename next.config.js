/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(process.env.STANDALONE === 'true' ? { output: 'standalone' } : {}),

  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },

  env: {
    OPENCLAW_BASE_URL: process.env.OPENCLAW_BASE_URL || 'https://downloading-after-wizard-virtue.trycloudflare.com',
    OPENCLAW_API_KEY: process.env.OPENCLAW_API_KEY || '76d0f4b9c277c5e457d64d908fc51fe0a2e8a93664b30806',
    OPENCLAW_MODEL: process.env.OPENCLAW_MODEL || 'openclaw:neo',
  },

  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
    serverComponentsExternalPackages: [
      'playwright-core',
      '@sparticuz/chromium',
    ],
  },

  // Security headers applied at the server level (backup for middleware)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
      {
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
    ];
  },
}

module.exports = nextConfig
