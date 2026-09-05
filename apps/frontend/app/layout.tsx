import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { ReactQueryProvider } from "@/lib/react-query";
import { ThemeProvider } from "@/theme/provider";
import FaviconManager from "@/components/FaviconManager";
import TitleManager from "@/components/TitleManager";
import PermissionDeniedModal from "@/components/ui/PermissionDeniedModal";
import AnalyticsProvider from "@/components/analytics/AnalyticsProvider";
import ClarityProvider from "@/components/analytics/ClarityProvider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const DEFAULT_TITLE = "Human Resources Management System";

// Mobile viewport: fit device width so the responsive layout works on phones,
// and `viewportFit: cover` exposes the safe-area insets used in globals.css.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * Server-rendered title from the company name in settings.
 *
 * This must live in metadata (not just a client effect): Next re-applies the
 * route's metadata title on every client navigation, so a client-only
 * document.title would get overwritten on each page change. `TitleManager`
 * still handles instant live updates after the name is saved (no reload).
 */
export async function generateMetadata(): Promise<Metadata> {
  const base = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";
  let title = DEFAULT_TITLE;
  try {
    const res = await fetch(`${base}/system-settings/public`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(3000), // fail fast if backend is unreachable
    });
    if (res.ok) {
      const json = await res.json();
      title = json?.data?.company_name?.trim() || DEFAULT_TITLE;
    }
  } catch {
    // Backend unreachable or timed out — fall back to the default title.
  }
  return {
    title,
    description: "Modern and professional human resource management system",
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning data-scroll-behavior="smooth">
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/*
         * ThemeProvider — reads active preset from theme/index.ts and writes
         * all CSS vars to <html>. Also handles Google Fonts + favicon injection.
         * To rebrand: change the export in theme/index.ts. Nothing else needed.
         */}
        <ThemeProvider>
          <ReactQueryProvider>
            {/*
             * GA4. Renders null unless NEXT_PUBLIC_GA_MEASUREMENT_ID is set, and
             * every call inside it is try/caught — see lib/analytics/gtag.ts.
             * Mounted here, above the dashboard shell, so /login is measured too.
             */}
            <AnalyticsProvider />
            {/*
             * Microsoft Clarity — session replay, heatmaps, engagement insight.
             * Renders null unless NEXT_PUBLIC_CLARITY_PROJECT_ID is set. Mounted
             * beside GA4 for the same reason: above the dashboard shell, so the
             * tag survives the /login → /dashboard transition. Recordings mask
             * the HR content itself — see docs/ANALYTICS-CLARITY.md.
             */}
            <ClarityProvider />
            <FaviconManager />
            <TitleManager />
            {children}
            <Toaster position="top-right" richColors closeButton />
            <PermissionDeniedModal />
          </ReactQueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
