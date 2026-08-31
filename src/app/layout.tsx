import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, IBM_Plex_Mono } from "next/font/google";
import { SiteFooter } from "@/components/site-footer";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
});

const utility = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-utility",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Web Application Baseline",
  description: "A secure, issue-driven starting point for a new web application.",
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#eef2f7",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${utility.variable}`}>
      <body>{children}<SiteFooter /></body>
    </html>
  );
}
