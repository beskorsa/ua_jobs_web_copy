// psycopg2/node-postgres не знают тип pgvector нативно — передаём и читаем
// его как текстовый литерал "[0.1,0.2,...]" (см. _vec_to_pgvector /
// _pgvector_to_vec в postgres_store.py — это тот же приём на TS).

export function vecToPg(vec: number[]): string {
  return "[" + vec.map((x) => x.toFixed(8)).join(",") + "]";
}

export function pgToVec(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map(Number);
}
