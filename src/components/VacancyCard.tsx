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
  work_mode?: "remote" | "office" | "hybrid" | null;
  matched_chunk?: string;
};

const WORK_MODE_LABEL: Record<"remote" | "office" | "hybrid", string> = {
  remote: "🏠 Віддалено",
  office: "🏢 Офіс",
  hybrid: "🏠🏢 Гібрид",
};

// matched_chunk — это кусок описания вакансії з середини тексту (найближчий
// збіг при семантичному пошуку), тому за замовчуванням він і починається,
// і закінчується посеред слова. Косметичне підрізання: відкидаємо перше
// "слово", якщо воно виглядає як обрубок (починається з малої літери — тобто
// не початок речення), і не обрізаємо останнє слово навпіл.
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

// Джерела, для яких немає власної індексованої сторінки /vacancies/[id]
// (розовий текст, вставлений вручну, чи разово розібране посилання) — див.
// PUBLIC_LISTING_EXCLUDED_SOURCES у lib/vacancies.ts. Тримаємо той самий
// список тут же (без імпорту серверного lib у клієнтський компонент), щоб
// для таких карток лишити пряме посилання на оригінал, а не на 404.
const NO_INTERNAL_PAGE_SOURCES = new Set(["pasted_text", "external_link"]);

export function VacancyCard({ vacancy, index }: { vacancy: VacancyCardData; index?: number }) {
  const salary =
    vacancy.salary_min || vacancy.salary_max
      ? `${vacancy.salary_min ?? "?"}–${vacancy.salary_max ?? "?"} ${vacancy.salary_currency ?? ""}`
      : null;

  // Для вакансій з реальних джерел скрейпера ведемо на власну сторінку
  // /vacancies/{id} (SSR + JobPosting-розмітка для Google) — вона вже сама
  // містить кнопку переходу на оригінал. Для разово розібраних посилань чи
  // вставленого тексту такої сторінки немає — лишаємо прямий зовнішній лінк.
  const isInternal = vacancy.source ? !NO_INTERNAL_PAGE_SOURCES.has(vacancy.source) : false;
  const href = isInternal ? `/vacancies/${vacancy.id}` : vacancy.url;
  const linkProps = isInternal ? {} : { target: "_blank", rel: "noreferrer" };

  return (
    <a href={href} {...linkProps} className="vacancy-card">
      {index != null && <span className="vacancy-card__index">#{index}</span>}
      <h3>{vacancy.title}</h3>
      <p className="vacancy-card__meta">
        {vacancy.company ?? "Компанія не вказана"}
        {vacancy.source ? ` · ${vacancy.source}` : ""}
        {vacancy.city ? ` · ${vacancy.city}` : ""}
      </p>
      {vacancy.work_mode && (
        <span className={`vacancy-card__work-mode vacancy-card__work-mode--${vacancy.work_mode}`}>
          {WORK_MODE_LABEL[vacancy.work_mode]}
        </span>
      )}
      {salary && <p className="vacancy-card__salary">{salary}</p>}
      {vacancy.matched_chunk && <p className="vacancy-card__snippet">{trimSnippet(vacancy.matched_chunk)}</p>}
    </a>
  );
}
