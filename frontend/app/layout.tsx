import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { TerminalProvider } from '@/lib/terminal-context';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: {
    default: 'TradePilot — XAU/USD & Forex Trading Terminal',
    template: '%s · TradePilot',
  },
  description:
    'TradePilot is a web trading terminal for XAU/USD and Forex. Demo trading works out of the box; live trading requires your own MetaTrader 5 account, connected through the TradePilot MT5 bridge.',
  applicationName: 'TradePilot',
  robots: { index: false, follow: false },
  manifest: '/manifest.webmanifest',
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { url: '/icon.svg', type: 'image/svg+xml', sizes: 'any' },
    ],
    apple: [{ url: '/icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: 'TradePilot',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  themeColor: '#0b1220',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} font-sans antialiased`}>
        <TerminalProvider>{children}</TerminalProvider>
      </body>
    </html>
  );
}
