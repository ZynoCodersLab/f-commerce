import type { Metadata } from 'next';
import { DM_Sans, IBM_Plex_Mono } from 'next/font/google';
import { ThemeBoundary } from '@/components/theme/theme';
import { BusinessSettingsProvider } from '@/components/business/business-settings-provider';
import './globals.css';

const dmSans = DM_Sans({
  variable: '--font-dm-sans',
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

const plexMono = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'F Commerce Order Desk',
  description: 'A clear order desk for growing commerce teams.',
  manifest: '/site.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png' }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${dmSans.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      {/* Grammarly and similar extensions add attributes to body before React hydrates. */}
      <body suppressHydrationWarning>
        <ThemeBoundary>
          <BusinessSettingsProvider>{children}</BusinessSettingsProvider>
        </ThemeBoundary>
      </body>
    </html>
  );
}
