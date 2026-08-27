import type { MetadataRoute } from "next";

// Сайт зараз — фактично одна сторінка (SPA-подібний чат), тож sitemap
// тривіальний: єдиний запис на головну. Головне тут не список URL, а сам
// факт наявності /sitemap.xml — Google Search Console просить його явно
// при подачі сайту на індексацію.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://ua-jobs-web.vercel.app";
  return [
    {
      url: base,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
  ];
}
