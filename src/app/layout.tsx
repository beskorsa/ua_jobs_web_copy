import "./globals.css";
import type { Metadata } from "next";

// Продакшн-домен фіксований тут (не .env), бо metadataBase потрібен вже на
// етапі build/SSR для абсолютних URL у OpenGraph/canonical — простіше і
// надійніше захардкодити один продакшн-домен, ніж тягнути VERCEL_URL
// (який на preview-деплоях інший і не той, що індексує Google).
const SITE_URL = "https://ua-jobs-web.vercel.app";
const TITLE = "Пошук вакансій з AI — Знайди роботу швидше";
const DESCRIPTION =
  "AI-пошук роботи в Україні: завантаж резюме, введи ключові слова або посилання на вакансію — " +
  "AI підбере релевантні вакансії з work.ua, robota.ua, DOU, Djinni та інших сайтів і підготує cover letter.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s — Пошук вакансій з AI",
  },
  description: DESCRIPTION,
  keywords: [
    "пошук роботи",
    "вакансії україна",
    "AI пошук вакансій",
    "резюме онлайн",
    "cover letter",
    "work.ua",
    "robota.ua",
    "djinni",
  ],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "uk_UA",
    url: SITE_URL,
    siteName: "Пошук вакансій з AI",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
  },
  // Підтвердження власності сайту в Google Search Console (метод "Тег
  // HTML") — Next.js сам рендерить це як <meta name="google-site-verification">
  // у <head>. Прибирати не можна, інакше підтвердження злетить.
  verification: {
    google: "siWU2KW1H5uCTc-Ha7QIOeEo76xWUvJVyIodAWYvO5o",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}
