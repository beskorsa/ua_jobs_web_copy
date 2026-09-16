import { query } from "./db";

// Курси НБУ (bank.gov.ua) — офіційний курс, оновлюється раз на банківський
// день. Кешуємо в Postgres (exchange_rates), щоб не смикати зовнішній API
// на кожен запит вакансій: STALE_AFTER_MS балансує свіжість курсу і
// кількість зовнішніх запитів.
const STALE_AFTER_MS = 12 * 60 * 60 * 1000; // 12 годин
const NBU_URL = "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json";

type NbuRateRow = { cc: string; rate: number };
type CachedRateRow = { currency: string; rate_uah: string; updated_at: string };

async function fetchNbuRates(): Promise<Record<string, number>> {
  const res = await fetch(NBU_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`NBU API відповів ${res.status}`);
  const data = (await res.json()) as NbuRateRow[];
  const out: Record<string, number> = {};
  for (const row of data) {
    if (row.cc === "USD" || row.cc === "EUR") out[row.cc] = row.rate;
  }
  return out;
}

let memCache: { rates: Record<string, number>; fetchedAt: number } | null = null;

/**
 * Повертає курси НБУ у форматі { USD: грн за 1 USD, EUR: грн за 1 EUR }.
 * Порядок джерел: пам'ять процесу (живе, поки жива serverless-функція) →
 * Postgres-кеш (переживає холодний старт) → реальний запит до bank.gov.ua.
 * Якщо зовнішній API недоступний, а кеш у базі є (навіть застарілий) —
 * повертаємо його: краще трохи неточний курс, ніж взагалі не показати
 * зарплату в USD.
 */
export async function getNbuRates(): Promise<Record<string, number>> {
  const now = Date.now();
  if (memCache && now - memCache.fetchedAt < STALE_AFTER_MS) return memCache.rates;

  const cached = await query<CachedRateRow>(`select currency, rate_uah, updated_at from exchange_rates`);
  const cachedMap = Object.fromEntries(cached.map((r) => [r.currency, Number(r.rate_uah)]));
  const freshEnough =
    cached.length >= 2 && cached.every((r) => now - new Date(r.updated_at).getTime() < STALE_AFTER_MS);
  if (freshEnough) {
    memCache = { rates: cachedMap, fetchedAt: now };
    return cachedMap;
  }

  try {
    const fresh = await fetchNbuRates();
    for (const [currency, rate] of Object.entries(fresh)) {
      await query(
        `insert into exchange_rates (currency, rate_uah, updated_at) values ($1, $2, now())
         on conflict (currency) do update set rate_uah = excluded.rate_uah, updated_at = now()`,
        [currency, rate],
      );
    }
    memCache = { rates: fresh, fetchedAt: now };
    return fresh;
  } catch (e) {
    console.error("[currency] запит до НБУ не вдався, використовую кеш із бази", e);
    if (Object.keys(cachedMap).length) {
      memCache = { rates: cachedMap, fetchedAt: now };
      return cachedMap;
    }
    throw e;
  }
}

/**
 * Конвертує зарплату (min/max у вихідній валюті) у USD за поточним курсом
 * НБУ. Якщо валюта вже USD — повертає без змін. Підтримує UAH і EUR (EUR
 * конвертується крос-курсом через гривню — окремого EUR/USD НБУ не
 * публікує). Якщо валюта невідома, або курс отримати не вдалось — повертає
 * вихідні значення без змін (краще показати зарплату в оригінальній валюті,
 * ніж не показати взагалі).
 */
export async function toUsdSalary(
  min: number | null,
  max: number | null,
  currency: string | null,
): Promise<{ min: number | null; max: number | null; currency: string | null }> {
  if (min == null && max == null) return { min, max, currency };
  const cur = (currency || "").toUpperCase();
  if (!cur || cur === "USD") return { min, max, currency };
  if (cur !== "UAH" && cur !== "EUR") return { min, max, currency };

  let rates: Record<string, number>;
  try {
    rates = await getNbuRates();
  } catch {
    return { min, max, currency };
  }
  const usdRate = rates.USD;
  if (!usdRate) return { min, max, currency };

  const toUsd = (amount: number) => {
    if (cur === "UAH") return amount / usdRate;
    const eurRate = rates.EUR;
    if (!eurRate) return amount; // немає крос-курсу — краще не спотворювати число
    return (amount * eurRate) / usdRate;
  };

  return {
    min: min != null ? Math.round(toUsd(min)) : null,
    max: max != null ? Math.round(toUsd(max)) : null,
    currency: "USD",
  };
}
