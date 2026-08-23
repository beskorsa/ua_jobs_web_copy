import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Пошук вакансій з AI",
  description: "Пошук вакансій за ключовими словами або резюме, з AI-оцінкою релевантності та cover letter",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}
