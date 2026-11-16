import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy, buildSecurityHeaders, nextConfig } from './next.config';

const production = { development: false, production: true };
const development = { development: true, production: false };

function headersByName(headers: { key: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(headers.map(({ key, value }) => [key, value]));
}

describe('content security policy', () => {
  it('locks scripts, objects, and framing down in production', () => {
    const csp = buildContentSecurityPolicy(production);

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('allows Cloudinary images and local previews but no remote scripts', () => {
    const csp = buildContentSecurityPolicy(production);
    const scriptDirective = csp.split('; ').find((directive) => directive.startsWith('script-src'));

    expect(csp).toContain("img-src 'self' blob: data: https://res.cloudinary.com");
    expect(scriptDirective).toBe("script-src 'self' 'unsafe-inline'");
  });

  it('adds eval and WebSocket sources only for the development server', () => {
    const csp = buildContentSecurityPolicy(development);

    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain('ws: wss:');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});

describe('security headers', () => {
  it('sets baseline hardening headers in production', () => {
    const headers = headersByName(buildSecurityHeaders(production));

    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Permissions-Policy']).toContain('geolocation=()');
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['X-Permitted-Cross-Domain-Policies']).toBe('none');
    expect(headers['Strict-Transport-Security']).toContain('max-age=63072000');
  });

  it('does not advertise HSTS from a development server', () => {
    const headers = headersByName(buildSecurityHeaders(development));

    expect(headers['Strict-Transport-Security']).toBeUndefined();
    expect(headers['Content-Security-Policy']).toContain("'unsafe-eval'");
  });

  it('applies the headers to every route and hides the framework version', async () => {
    expect(nextConfig.poweredByHeader).toBe(false);

    const rules = await nextConfig.headers?.();

    const global = rules?.find((rule) => rule.source === '/(.*)');
    expect(global?.headers.map((header) => header.key)).toContain('Content-Security-Policy');
  });

  it('keeps invite links out of referrers and shared caches', async () => {
    const rules = await nextConfig.headers?.();
    const invite = rules?.find((rule) => rule.source === '/invite/:path*');

    expect(invite).toBeDefined();
    expect(headersByName(invite?.headers ?? [])['Referrer-Policy']).toBe('no-referrer');
    // A stored copy of the preview document would be another person's invite.
    expect(headersByName(invite?.headers ?? [])['Cache-Control']).toBe('no-store');
    expect(headersByName(invite?.headers ?? [])['X-Robots-Tag']).toContain('noindex');
  });
});
