import type { Metadata } from "next";
import { Inter } from "next/font/google";
import AccessGate from "@/components/access-gate";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TV Video",
  description: "Stream your cloud videos on your TV",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} bg-tv-bg text-tv-text antialiased`}>
        <AccessGate>{children}</AccessGate>
      </body>
    </html>
  );
}
