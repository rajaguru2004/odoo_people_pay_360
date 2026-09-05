import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import { ReactQueryProvider } from '@/lib/react-query';
import { ThemeProvider } from '@/theme/provider';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import TitleManager from '@/components/common/TitleManager';
import PermissionDeniedModal from '@/components/ui/PermissionDeniedModal';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

const DEFAULT_TITLE = process.env.NEXT_PUBLIC_APP_NAME || 'People Pay 360';

// `viewportFit: cover` is what exposes the safe-area insets the layout uses, so
// a notched phone does not put content under the status bar.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

/**
 * Server-rendered title from the company name in settings.
 *
 * This must live in metadata rather than in a client effect: Next re-applies a
 * route's metadata title on every client navigation, so a client-only
 * document.title gets overwritten on each page change. TitleManager still
 * handles the live update after the name is saved.
 */
export async function generateMetadata(): Promise<Metadata> {
  const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3011';
  let title = DEFAULT_TITLE;

  try {
    const res = await fetch(`${base}/system-settings/public`, {
      next: { revalidate: 60 },
      // Fail fast. Without this, an unreachable backend holds the whole page
      // render open until the default fetch timeout.
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const json = await res.json();
      title = json?.data?.company_name?.trim() || DEFAULT_TITLE;
    }
  } catch {
    // Backend unreachable or timed out — fall back to the default title.
  }

  return { title, description: 'HR and payroll platform' };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning data-scroll-behavior="smooth">
      <body suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {/*
         * ThemeProvider reads the active preset (theme/index.ts + the branding
         * store) and writes every CSS var onto <html>. To rebrand: change the
         * export in theme/index.ts. Nothing else needs to move.
         */}
        <ThemeProvider>
          {/*
           * LocaleProvider sits above everything, not just the dashboard: the
           * language is chosen per browser (store/localeStore.ts), so the login
           * screen has to read it too — before there is a user to ask.
           */}
          <LocaleProvider>
            <ReactQueryProvider>
              <TitleManager />
              {children}
              <Toaster position="top-right" richColors closeButton />
              <PermissionDeniedModal />
            </ReactQueryProvider>
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
