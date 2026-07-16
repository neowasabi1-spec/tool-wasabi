/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(process.env.STANDALONE === 'true' ? { output: 'standalone' } : {}),

  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },

  /** Netlify/Vercel CI: some App Route GET handlers were pre-rendered at build and hit localhost (60s+). */
  staticPageGenerationTimeout: 300,


  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
    serverComponentsExternalPackages: [
      'playwright-core',
      '@sparticuz/chromium-min',
    ],
    // Make the copywriting knowledge base available to API routes at runtime
    // on Netlify (otherwise readFileSync fails because the .md files in
    // src/knowledge/copywriting/raw/ are not traced as dependencies).
    outputFileTracingIncludes: {
      '/api/**/*': ['./src/knowledge/**/*'],
    },
  },

  webpack: (config) => {
    config.resolve.alias.canvas = false;
    config.resolve.alias.encoding = false;
    return config;
  },

  // Expose the OAuth discovery documents at the spec-mandated root
  // `/.well-known/*` paths, backed by our API route handlers. Path-suffix
  // variants are included because MCP clients may probe resource-scoped
  // metadata (e.g. `/.well-known/oauth-authorization-server/api/mcp`).
  async rewrites() {
    return [
      {
        source: '/.well-known/oauth-protected-resource',
        destination: '/api/mcp/meta/protected-resource',
      },
      {
        source: '/.well-known/oauth-protected-resource/:path*',
        destination: '/api/mcp/meta/protected-resource',
      },
      {
        source: '/.well-known/oauth-authorization-server',
        destination: '/api/mcp/meta/authorization-server',
      },
      {
        source: '/.well-known/oauth-authorization-server/:path*',
        destination: '/api/mcp/meta/authorization-server',
      },
    ];
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
