"use client";

import { useRef, useState, type FormEvent, type ChangeEvent } from "react";
import { VacancyList } from "@/components/VacancyList";
import type { VacancyCardData } from "@/components/VacancyCard";

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
};

const INTRO =
  "Привіт! Введіть ключові слова для пошуку вакансій, завантажте резюме (PDF) — " +
  "підберу вакансії під нього, або запитайте в чаті про cover letter чи поради, як покращити резюме.";

export default function Home() {
  const [query, setQuery] = useState("");
  const [vacancies, setVacancies] = useState<VacancyCardData[]>([]);
  const [resumeId, setResumeId] = useState<number | null>(null);
  const [resumeSummary, setResumeSummary] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", content: INTRO }]);
  const [chatInput, setChatInput] = useState("");
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function pushError(err: unknown) {
    const text = err instanceof Error ? err.message : String(err);
    setMessages((m) => [...m, { role: "assistant", content: `Помилка: ${text}` }]);
  }

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
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
    } catch (err) {
      pushError(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
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
    } catch (err) {
      pushError(err);
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleChatSend(e: FormEvent) {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    setChatInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setLoading(true);
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

      if (data.action === "search" && data.results) setVacancies(data.results);

      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: data.reply,
          vacancies: data.action === "search" ? data.results : undefined,
          coverLetter:
            data.action === "cover_letter"
              ? { ...data, vacancyTitle: data.vacancy?.title }
              : undefined,
          tips: data.action === "recommendations" ? data.tips : undefined,
        },
      ]);
    } catch (err) {
      pushError(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <header className="page__header">
        <h1>Пошук вакансій з AI</h1>
        <p>Введіть ключові слова або завантажте резюме — покажу релевантні вакансії, напишу cover letter і дам поради.</p>
      </header>

      <section className="controls">
        <form onSubmit={handleSearch} className="search-form">
          <input
            type="text"
            placeholder="Наприклад: python розробник, віддалено, Київ"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" disabled={loading}>
            Знайти
          </button>
        </form>
        <label className="upload-button">
          {resumeSummary ? "Резюме завантажено ✓ (завантажити інше)" : "Завантажити резюме (PDF)"}
          <input ref={fileInputRef} type="file" accept="application/pdf" onChange={handleUpload} hidden />
        </label>
      </section>

      {loading && <p className="loading">Завантаження…</p>}

      <VacancyList vacancies={vacancies} />

      <section className="chat">
        <div className="chat__messages">
          {messages.map((m, i) => (
            <div key={i} className={`chat__bubble chat__bubble--${m.role}`}>
              <p>{m.content}</p>
              {m.vacancies && <VacancyList vacancies={m.vacancies} />}
              {m.coverLetter && (
                <div className="cover-letter">
                  <p>
                    <strong>{m.coverLetter.vacancyTitle}</strong> — релевантність {m.coverLetter.relevance}/10
                  </p>
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
          ))}
        </div>
        <form onSubmit={handleChatSend} className="chat__input">
          <input
            type="text"
            placeholder="Запитайте про cover letter, поради по резюме, або уточніть пошук…"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
          />
          <button type="submit" disabled={loading}>
            Надіслати
          </button>
        </form>
      </section>
    </main>
  );
}
