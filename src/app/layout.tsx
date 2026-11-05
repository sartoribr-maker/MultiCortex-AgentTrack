import type { Metadata, Viewport } from "next";
import { Carlito } from "next/font/google";
import "./devcore.css";

const carlito = Carlito({ variable: "--font-carlito", subsets: ["latin"], weight: ["400", "700"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "DevCore Monitor · MultiCortex", template: "%s · DevCore Monitor" },
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export const viewport: Viewport = { themeColor: "#1f3a5f" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${carlito.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
