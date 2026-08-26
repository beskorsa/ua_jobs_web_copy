"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

type Kind = "include" | "exclude";

type Props = {
  kind: Kind;
  label: string;
  placeholder: string;
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
};

// Тег-інпут з автопідказками зі словника (search_keywords, див.
// src/lib/keywords.ts / api/keywords/route.ts). Дропдаун — лише підказка:
// слово, якого немає в словнику, все одно можна додати як тег — воно
// потрапить у словник пізніше, коли реально буде застосований пошук
// (touchKeyword викликається з /api/search, не звідси).
export function TagInput({ kind, label, placeholder, tags, onChange, disabled }: Props) {
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function fetchSuggestions(q: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/keywords?kind=${kind}&q=${encodeURIComponent(q)}`);
        const data = await res.json();
        setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      } catch {
        setSuggestions([]);
      }
    }, 200);
  }

  function addTag(raw: string) {
    const v = raw.trim();
    if (!v) return;
    if (!tags.some((t) => t.toLowerCase() === v.toLowerCase())) {
      onChange([...tags, v]);
    }
    setText("");
    setSuggestions([]);
    setActiveIndex(-1);
    setOpen(false);
  }

  function removeTag(idx: number) {
    onChange(tags.filter((_, i) => i !== idx));
  }

  function handleChange(v: string) {
    // Кома — теж спосіб зафіксувати тег (звично для тег-інпутів).
    if (v.includes(",")) {
      const [head, ...rest] = v.split(",");
      addTag(head);
      setText(rest.join(","));
      return;
    }
    setText(v);
    setOpen(true);
    fetchSuggestions(v);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && suggestions[activeIndex]) {
        addTag(suggestions[activeIndex]);
      } else {
        addTag(text);
      }
      return;
    }
    if (e.key === "Backspace" && !text && tags.length) {
      removeTag(tags.length - 1);
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className={`tag-input tag-input--${kind}`} ref={boxRef}>
      <span className="tag-input__label">{label}</span>
      <div className="tag-input__box">
        {tags.map((t, i) => (
          <span key={t} className="tag-input__chip">
            {t}
            <button
              type="button"
              className="tag-input__chip-remove"
              onClick={() => removeTag(i)}
              disabled={disabled}
              aria-label={`Прибрати "${t}"`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={text}
          placeholder={tags.length ? "" : placeholder}
          disabled={disabled}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            setOpen(true);
            fetchSuggestions(text);
          }}
        />
      </div>
      {open && suggestions.length > 0 && (
        <ul className="tag-input__dropdown">
          {suggestions
            .filter((s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()))
            .map((s, i) => (
              <li
                key={s}
                className={i === activeIndex ? "is-active" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  addTag(s);
                }}
              >
                {s}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
