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

export function VacancyCard({ vacancy, index }: { vacancy: VacancyCardData; index?: number }) {
  const salary =
    vacancy.salary_min || vacancy.salary_max
      ? `${vacancy.salary_min ?? "?"}–${vacancy.salary_max ?? "?"} ${vacancy.salary_currency ?? ""}`
      : null;

  return (
    <a href={vacancy.url} target="_blank" rel="noreferrer" className="vacancy-card">
      {index != null && <span className="vacancy-card__index">#{index}</span>}
      <h3>{vacancy.title}</h3>
      <p className="vacancy-card__meta">
        {vacancy.company ?? "Компанія не вказана"}
        {vacancy.source ? ` · ${vacancy.source}` : ""}
        {vacancy.city ? ` · ${vacancy.city}` : ""}
      </p>
      {salary && <p className="vacancy-card__salary">{salary}</p>}
      {vacancy.matched_chunk && <p className="vacancy-card__snippet">{vacancy.matched_chunk.slice(0, 160)}…</p>}
    </a>
  );
}
