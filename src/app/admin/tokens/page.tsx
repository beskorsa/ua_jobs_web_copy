export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { timingSafeEqual } from "node:crypto";
import { ensureSchema } from "@/lib/schema";
import { getUsageStats } from "@/lib/tokenUsage";

// Звичайне "a !== b" порівнює посимвольно і виходить одразу на першому
// розбіжному байті — теоретично за різницею в часі відповіді можна підбирати
// ключ по одному символу (timing attack). Ризик тут невисокий (секрет вводить
// вручну одна людина, не публічний логін-флоу), але виправити дешево:
// timingSafeEqual порівнює за постійний час незалежно від того, де перша
// розбіжність. Буфери мають бути однакової довжини — інакше кидає виняток,
// тому при розбіжній довжині все одно виконуємо порівняння (з ключем самим
// із собою, щоб не "зливати" довжину явною короткою гілкою) і повертаємо false.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// Проста сторінка-звіт, захищена лише секретним ключем у query-параметрі
// (?key=...), що звіряється з process.env.ADMIN_KEY — без повноцінної
// автентифікації, бо це внутрішній інструмент для однієї людини (власниці
// проєкту), не публічна фіча сайту. Немає ADMIN_KEY у env — сторінка
// відмовляє взагалі (fail closed), а не пропускає всіх.
const COLORS = {
  bg: "#0a0b0d",
  surface: "#131519",
  border: "#23262c",
  text: "#f2f3f5",
  textDim: "#9a9fa8",
  textFaint: "#5c6169",
  accent: "#5b8cff",
};

function fmtNum(n: number): string {
  return new Intl.NumberFormat("uk-UA").format(n);
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 14,
        padding: "16px 20px",
        minWidth: 160,
      }}
    >
      <div style={{ fontSize: 13, color: COLORS.textDim, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, color: COLORS.text }}>{value}</div>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "left",
                  padding: "8px 12px",
                  borderBottom: `1px solid ${COLORS.border}`,
                  color: COLORS.textDim,
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={headers.length} style={{ padding: "12px", color: COLORS.textFaint }}>
                Немає даних за цей період
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    style={{
                      padding: "8px 12px",
                      borderBottom: `1px solid ${COLORS.border}`,
                      color: COLORS.text,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default async function TokensAdminPage({
  searchParams,
}: {
  searchParams: { key?: string; days?: string };
}) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || !searchParams.key || !safeEqual(searchParams.key, adminKey)) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: COLORS.bg,
          color: COLORS.text,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "sans-serif",
        }}
      >
        403 — доступ заборонено
      </div>
    );
  }

  await ensureSchema();
  const periodDays = searchParams.days ? Number(searchParams.days) : 30;
  const stats = await getUsageStats(Number.isFinite(periodDays) ? periodDays : 30);

  const periodLabel = stats.periodDays === 0 ? "за весь час" : `за останні ${stats.periodDays} дн.`;
  const periodLinks = [7, 30, 90, 0];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: COLORS.bg,
        color: COLORS.text,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        padding: "32px 24px",
      }}
    >
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 4 }}>Витрати токенів OpenAI</h1>
        <div style={{ color: COLORS.textDim, marginBottom: 20 }}>
          {periodLabel}
          {" · "}
          {periodLinks.map((d, i) => (
            <span key={d}>
              {i > 0 && " · "}
              <a
                href={`?key=${encodeURIComponent(searchParams.key || "")}&days=${d}`}
                style={{ color: d === stats.periodDays ? COLORS.accent : COLORS.textDim }}
              >
                {d === 0 ? "весь час" : `${d} дн.`}
              </a>
            </span>
          ))}
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 28 }}>
          <StatCard label="Запитів" value={fmtNum(stats.totals.requests)} />
          <StatCard label="Токенів усього" value={fmtNum(stats.totals.totalTokens)} />
          <StatCard label="Орієнтовна вартість" value={fmtUsd(stats.totals.estimatedCostUsd)} />
        </div>

        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>За типом запиту</h2>
        <div style={{ marginBottom: 28 }}>
          <Table
            headers={["Тип", "Запитів", "Токенів", "Вартість"]}
            rows={stats.byKind.map((r) => [r.kind, fmtNum(r.requests), fmtNum(r.totalTokens), fmtUsd(r.estimatedCostUsd)])}
          />
        </div>

        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>За типом + моделлю</h2>
        <div style={{ marginBottom: 28 }}>
          <Table
            headers={["Тип", "Модель", "Запитів", "Prompt", "Completion", "Токенів", "Вартість"]}
            rows={stats.byKindModel.map((r) => [
              r.kind,
              r.model,
              fmtNum(r.requests),
              fmtNum(r.promptTokens),
              fmtNum(r.completionTokens),
              fmtNum(r.totalTokens),
              fmtUsd(r.estimatedCostUsd),
            ])}
          />
        </div>

        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>За днями</h2>
        <div>
          <Table
            headers={["День", "Токенів"]}
            rows={stats.byDay.map((r) => [r.day, fmtNum(r.totalTokens)])}
          />
        </div>

        <div style={{ marginTop: 28, fontSize: 12, color: COLORS.textFaint }}>
          Вартість — орієнтовна оцінка за публічним прайсом OpenAI (див. src/lib/tokenUsage.ts), не бухгалтерська цифра.
        </div>
      </div>
    </div>
  );
}
