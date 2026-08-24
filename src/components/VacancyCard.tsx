export type VacancyCardData = {
  id: number;
  title: string;
  company?: string | null;
  source?: string;
  url: string;
  city?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  salary_currency?: string | null;
  matched_chunk?: string;
};

// Обрезка сниппета без разрывов посреди слова (в начале и в конце) — сырые
// сниппеты из БД часто начинаются/заканчиваются на полуслове.
function trimSnippet(text: string, maxLen = 160): string {
  let s = text.trim();

  const firstSpace = s.indexOf(" ");
  if (firstSpace > 0 && firstSpace <= 6) {
    const firstWord = s.slice(0, firstSpace);
    if (/^[a-zа-яіїєґ]/.test(firstWord)) {
      s = s.slice(firstSpace + 1).trim();
    }
  }

  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

export function VacancyCard({ vacancy, index }: { vacancy: VacancyCardData; index?: number }) {
  const salary =
    vacancy.salary_min || vacancy.salary_max
      ? `${vacancy.salary_min ?? "від"}–${vacancy.salary_max ?? "?"} ${vacancy.salary_currency ?? ""}`.trim()
      : null;

  const metaParts = [vacancy.company ?? "Компанія не вказана", vacancy.city].filter(Boolean);

  return (
    <a
      href={vacancy.url}
      target="_blank"
      rel="noreferrer"
      className="vacancy-card"
      style={index != null ? ({ "--i": index } as React.CSSProperties) : undefined}
    >
      {index != null && <span className="vacancy-card__index">#{index}</span>}
      <h3>{vacancy.title}</h3>
      <p className="vacancy-card__meta">{metaParts.join(" · ")}</p>
      {salary && <span className="vacancy-card__salary">{salary}</span>}
      {vacancy.matched_chunk && <p className="vacancy-card__snippet">{trimSnippet(vacancy.matched_chunk)}</p>}
    </a>
  );
}
