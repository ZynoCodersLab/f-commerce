import type { NextConfig } from 'next';

/**
 * The API origin the browser's /api/* calls are proxied to. Read when Next
 * evaluates this config (at build time for `next build`), so every deploy
 * supplies the value from its environment instead of relying on a host name
 * baked into the code. A production build fails loudly when it is missing,
 * because the local development fallback would deploy a proxy that points at
 * localhost. Trailing slashes are trimmed so the proxy path never becomes
 * `/api//...`.
 */
const configuredApiOrigin = process.env.API_ORIGIN?.trim();

if (!configuredApiOrigin && process.env.NODE_ENV === 'production') {
  throw new Error('API_ORIGIN must be set to the deployed API origin for a production build.');
}

function parseApiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`API_ORIGIN must be an absolute URL. Received: "${value}"`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`API_ORIGIN must use http or https. Received: "${value}"`);
  }

  return value.replace(/\/+$/, '');
}

const apiOrigin = parseApiOrigin(configuredApiOrigin ?? 'http://localhost:4000');

const isDevelopment = process.env.NODE_ENV === 'development';
const isProduction = process.env.NODE_ENV === 'production';

/** Cloudinary serves business logos and product images. */
const CLOUDINARY_IMAGE_ORIGIN = 'https://res.cloudinary.com';

type SecurityHeader = { key: string; value: string };

interface SecurityHeaderOptions {
  development: boolean;
  production: boolean;
}

/**
 * The browser holds the access token in localStorage, so a strict script
 * policy is the main defense against token theft through injected code. The
 * policy lives in next.config instead of a request-time nonce because the app
 * uses statically rendered pages. Without a nonce Next.js needs
 * `'unsafe-inline'` for its bootstrap and streaming scripts, and React needs it
 * for inline styles. Everything else stays locked to this origin.
 *
 * `'unsafe-eval'` and WebSocket sources are development-only: React uses eval
 * for its development error overlay and the Next dev server streams HMR over a
 * WebSocket. Production needs neither.
 */
export function buildContentSecurityPolicy({
  development,
  production,
}: SecurityHeaderOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // Blob URLs back the local onboarding logo preview.
    `img-src 'self' blob: data: ${CLOUDINARY_IMAGE_ORIGIN}`,
    "font-src 'self' data:",
    // Browser code calls this origin only; the Next server proxies /api/*.
    `connect-src 'self'${development ? ' ws: wss:' : ''}`,
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
  ];

  if (production) {
    directives.push('upgrade-insecure-requests');
  }

  return directives.join('; ');
}

/** Response headers applied to every frontend route. */
export function buildSecurityHeaders(options: SecurityHeaderOptions): SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: 'Content-Security-Policy', value: buildContentSecurityPolicy(options) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
    },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
  ];

  if (options.production) {
    // The host terminates TLS, so only a production build advertises HSTS.
    headers.push({
      key: 'Strict-Transport-Security',
      value: 'max-age=63072000; includeSubDomains',
    });
  }

  return headers;
}

export const nextConfig: NextConfig = {
  // The framework version is not useful to a client.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: buildSecurityHeaders({ development: isDevelopment, production: isProduction }),
      },
      {
        // An invite link carries a secret in its path. Keep it out of Referer
        // headers sent to other sites and out of search indexes.
        source: '/invite/:path*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiOrigin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
