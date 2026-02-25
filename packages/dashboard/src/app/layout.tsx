import "@/styles/globals.css"

import type { Metadata } from "next"

import { NavShell } from "@/components/layout/nav-shell"

export const metadata: Metadata = {
  title: "Cortex Plane",
  description: "Agent orchestration dashboard",
}

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en" className="dark">
      <body className="bg-gray-950 text-gray-100 antialiased">
        <NavShell>{children}</NavShell>
      </body>
    </html>
  )
}
