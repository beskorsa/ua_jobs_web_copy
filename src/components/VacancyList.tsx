"use client";

import { useState } from "react";
import { VacancyCard, type VacancyCardData } from "./VacancyCard";

type Props = {
  vacancies: VacancyCardData[];
  // Старі повідомлення в чаті за замовчуванням згорнуті (лише останній
  // результат пошуку розгорнутий одразу) — інакше після кількох пошуків
  // чат перетворюється на нескінченну стрічку карток, у якій незручно
  // прокручувати до останнього повідомлення.
  defaultOpen?: boolean;
};

export function VacancyList({ vacancies, defaultOpen = true }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  if (!vacancies?.length) return null;

  return (
    <div className="vacancy-list">
      <button
        type="button"
        className="vacancy-list__toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`vacancy-list__chevron${open ? " is-open" : ""}`}>▸</span>
        {open ? `Згорнути (${vacancies.length})` : `Показати вакансії (${vacancies.length})`}
      </button>
      {open && (
        <div className="vacancy-grid">
          {vacancies.map((v, i) => (
            <VacancyCard key={v.id} vacancy={v} index={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
