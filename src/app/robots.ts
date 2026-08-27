import type { MetadataRoute } from "next";

// Next.js сам віддає це як /robots.txt (App Router file convention) —
// окремого public/robots.txt не потрібно. Дозволяємо індексувати все, крім
// /api/* (не сторінки, нема сенсу) та /admin/* (внутрішній звіт по
// токенах, захищений ?key=, але краще й ботам туди не заглядати).
export default function robots(): MetadataRoute.Robots {
  const base = "https://ua-jobs-web.vercel.app";
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/admin/"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
