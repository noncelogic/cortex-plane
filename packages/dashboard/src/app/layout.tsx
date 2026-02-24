import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Cortex Plane",
  description: "Agent orchestration dashboard",
}

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
