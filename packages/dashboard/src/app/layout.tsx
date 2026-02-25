import "@/styles/globals.css"

import type { Metadata } from "next"

import { NavShell } from "@/components/layout/nav-shell"
import { ThemeProvider } from "@/components/theme-provider"

export const metadata: Metadata = {
  title: "Cortex Plane",
  description: "Agent orchestration dashboard",
}

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <NavShell>{children}</NavShell>
        </ThemeProvider>
      </body>
    </html>
  )
}
