import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
export const metadata: Metadata = { title: "SOUND CLASH — Your Voice. Your Territory.", description: "Real-time multiplayer voice territory game for 2–7 players." };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body className="bg-[#101522] text-white antialiased">{children}</body></html>;
}
