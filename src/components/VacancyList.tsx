import { VacancyCard, type VacancyCardData } from "./VacancyCard";

export function VacancyList({ vacancies }: { vacancies: VacancyCardData[] }) {
  if (!vacancies?.length) return null;
  return (
    <div className="vacancy-grid">
      {vacancies.map((v, i) => (
        <VacancyCard key={v.id} vacancy={v} index={i + 1} />
      ))}
    </div>
  );
}
