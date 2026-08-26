"use client";

import { useRef, useState, type FormEvent, type ChangeEvent } from "react";
import { VacancyList } from "@/components/VacancyList";
import type { VacancyCardData } from "@/components/VacancyCard";
import { TagInput } from "@/components/TagInput";

type CoverLetter = {
  relevance: number;
  reasoning: string;
  coverLetterSentences: string[];
  vacancyTitle?: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  vacancies?: VacancyCardData[];
  coverLetter?: CoverLetter;
  tips?: string[];
  isError?: boolean;
};

const INTRO =
  "Привіт! Введіть ключові слова для пошуку вакансій, вставте посилання на конкретну вакансію " +
  "для аналізу, або завантажте резюме (PDF) — підберу вакансії під нього. Після цього тут " +
  "з'явиться чат: можна буде попросити cover letter, поради по резюме або запитати про вакансію.";

function TypingBubble() {
  return (
    <div className="chat__bubble chat__bubble--assistant chat__bubble--typing" aria-label="Асистент друкує">
      <span />
      <span />
      <span />
    </div>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [minusKeywords, setMinusKeywords] = useState<string[]>([]);
  const [vacancies, setVacancies] = useState<VacancyCardData[]>([]);
  const [resumeId, setResumeId] = useState<number | null>(null);
  const [resumeSummary, setResumeSummary] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", content: INTRO }]);
  const [chatInput, setChatInput] = useState("");
  const [searching, setSearching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = searching || uploading || chatBusy;
  const isUrl = /^https?:\/\/\S+$/i.test(query.trim());

  function pushError(err: unknown) {
    const text = err instanceof Error ? err.message : String(err);
    setMessages((m) => [...m, { role: "assistant", content: text, isError: true }]);
    // Без цього: якщо перша ж дія користувача (аплоад/пошук/лінк) завершується
    // помилкою, чат-панель (яка рендериться лише за started === true, а
    // started виставлявся в true тільки при УСПІХУ) так і не з'являється —
    // повідомлення лежить у messages, але його ніде не видно. Саме це малося
    // на увазі під "PDF перестав оброблятися / повідомлення так і нема".
    setStarted(true);
  }

  // Якщо в полі пошуку посилання — це не ключові слова, а вакансія для
  // розбору: маршрутизуємо через /api/chat (analyze_vacancy_link), а не
  // /api/search. Головне поле пошуку — тепер єдина точка входу і для
  // ключових слів, і для лінків, бо чат-панель з'являється лише після
  // першої дії.
  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q || busy) return;

    if (isUrl) {
      await submitLink(q);
      return;
    }

    setSearching(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setVacancies(data.results);
      setMessages((m) => [
        ...m,
        { role: "user", content: q },
        { role: "assistant", content: `Знайшов ${data.results.length} вакансій.`, vacancies: data.results },
      ]);
      setStarted(true);
      setQuery("");
    } catch (err) {
      pushError(err);
    } finally {
      setSearching(false);
    }
  }

  // Пошук за тегами (ключові / мінус-слова) — окрема від головного поля
  // точка входу: тут завжди йде саме структурований пошук у /api/search
  // (з excludeTerms на рівні SQL), а не free-form текст/лінк.
  async function handleKeywordSearch(e: FormEvent) {
    e.preventDefault();
    if (!keywords.length || busy) return;

    setSearching(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords, minusKeywords }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setVacancies(data.results);
      const label = minusKeywords.length
        ? `${keywords.join(", ")} (виключити: ${minusKeywords.join(", ")})`
        : keywords.join(", ");
      setMessages((m) => [
        ...m,
        { role: "user", content: label },
        { role: "assistant", content: `Знайшов ${data.results.length} вакансій.`, vacancies: data.results },
      ]);
      setStarted(true);
    } catch (err) {
      pushError(err);
    } finally {
      setSearching(false);
    }
  }

  async function submitLink(url: string) {
    setSearching(true);
    setMessages((m) => [...m, { role: "user", content: url }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: url,
          resumeId,
          shownVacancies: vacancies.map((v) => ({ id: v.id, title: v.title })),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.results) setVacancies(data.results);
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: data.reply,
          vacancies: data.results ?? undefined,
          coverLetter:
            data.action === "cover_letter"
              ? { ...data.coverLetter, vacancyTitle: data.vacancy?.title }
              : undefined,
        },
      ]);
      setStarted(true);
      setQuery("");
    } catch (err) {
      pushError(err);
    } finally {
      setSearching(false);
    }
  }

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/resume", { method: "POST", body: form });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResumeId(data.resumeId);
      setResumeSummary(data.summary);
      setVacancies(data.results);
      setMessages((m) => [
        ...m,
        { role: "user", content: `Завантажено резюме: ${file.name}` },
        {
          role: "assistant",
          content: `${data.summary}\n\nПідібрав ${data.results.length} вакансій під це резюме.`,
          vacancies: data.results,
        },
      ]);
      setStarted(true);
    } catch (err) {
      pushError(err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleChatSend(e: FormEvent) {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text || busy) return;
    setChatInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setChatBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          resumeId,
          shownVacancies: vacancies.map((v) => ({ id: v.id, title: v.title })),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      if (data.results) setVacancies(data.results);

      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: data.reply,
          vacancies: data.results ?? undefined,
          coverLetter:
            data.action === "cover_letter"
              ? { ...data.coverLetter, vacancyTitle: data.vacancy?.title }
              : undefined,
          tips: data.action === "recommendations" ? data.tips : undefined,
        },
      ]);
    } catch (err) {
      pushError(err);
    } finally {
      setChatBusy(false);
    }
  }

  return (
    <main className="page">
      <header className="page__header">
        <span className="page__kicker">AI-пошук роботи</span>
        <h1>Пошук вакансій з AI</h1>
        <p>
          Введіть ключові слова, вставте посилання на вакансію або завантажте резюме — покажу релевантні
          вакансії, напишу cover letter і дам поради.
        </p>
      </header>

      <section className="controls">
        <form onSubmit={handleSearch} className="search-form">
          <input
            type="text"
            placeholder="Ключові слова (python розробник, віддалено) або посилання на вакансію"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" disabled={busy || !query.trim()}>
            {searching ? (isUrl ? "Аналізую…" : "Шукаю…") : isUrl ? "Аналізувати" : "Знайти"}
          </button>
        </form>
        <label className={`upload-button${resumeSummary ? " upload-button--done" : ""}`}>
          <svg className="upload-button__icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
            {resumeSummary ? (
              <path
                d="M20 6L9 17l-5-5"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              <path
                d="M12 3v12m0 0l-4-4m4 4l4-4M5 19h14"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>
          {uploading ? "Завантажую…" : resumeSummary ? "Резюме завантажено (замінити)" : "Завантажити резюме (PDF/DOCX)"}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx"
            onChange={handleUpload}
            hidden
            disabled={busy}
          />
        </label>
      </section>

      <form onSubmit={handleKeywordSearch} className="keyword-panel">
        <TagInput
          kind="include"
          label="Ключові слова"
          placeholder="python, віддалено, senior…"
          tags={keywords}
          onChange={setKeywords}
          disabled={busy}
        />
        <TagInput
          kind="exclude"
          label="Мінус-слова"
          placeholder="стажування, php…"
          tags={minusKeywords}
          onChange={setMinusKeywords}
          disabled={busy}
        />
        <div className="keyword-panel__submit">
          <button type="submit" disabled={busy || !keywords.length}>
            {searching ? "Шукаю…" : "Пошук за тегами"}
          </button>
        </div>
      </form>

      {started && (
      <section className="chat">
        <div className="chat__messages">
          {(() => {
            // Розгорнутим за замовчуванням лишаємо тільки останнє
            // повідомлення з вакансіями — інакше кожен новий пошук додає ще
            // одну повну сітку карток і чат стає незручним для прокрутки.
            let lastVacancyIdx = -1;
            messages.forEach((m, i) => {
              if (m.vacancies?.length) lastVacancyIdx = i;
            });
            return messages.map((m, i) => (
              <div
                key={i}
                className={`chat__bubble chat__bubble--${m.role}`}
              >
                {m.isError ? <p className="rate-limit-note">{m.content}</p> : <p>{m.content}</p>}
                {m.vacancies && <VacancyList vacancies={m.vacancies} defaultOpen={i === lastVacancyIdx} />}
                {m.coverLetter && (
                  <div className="cover-letter">
                    <span className="cover-letter__score">
                      {m.coverLetter.vacancyTitle} · {m.coverLetter.relevance}/10
                    </span>
                    <p>{m.coverLetter.reasoning}</p>
                    <ol>
                      {m.coverLetter.coverLetterSentences.map((s, j) => (
                        <li key={j}>{s}</li>
                      ))}
                    </ol>
                  </div>
                )}
                {m.tips && (
                  <ul className="tips">
                    {m.tips.map((t, j) => (
                      <li key={j}>{t}</li>
                    ))}
                  </ul>
                )}
              </div>
            ));
          })()}
          {chatBusy && <TypingBubble />}
        </div>
        <form onSubmit={handleChatSend} className="chat__input">
          <input
            type="text"
            placeholder="Запитайте про cover letter, поради по резюме, або уточніть пошук…"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            disabled={busy}
          />
          <button type="submit" disabled={busy || !chatInput.trim()}>
            Надіслати
          </button>
        </form>
      </section>
      )}
    </main>
  );
}
