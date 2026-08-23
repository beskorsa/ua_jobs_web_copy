// Разово применить схему БД без похода через API-роут (например, сразу
// после первого деплоя, до первого реального запроса на сайт).
// Запуск: npm run db:setup  (нужен .env.local с DATABASE_URL)
import "dotenv/config";
import { ensureSchema } from "../src/lib/schema";

ensureSchema()
  .then(() => {
    console.log("Схема готова.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("Не удалось применить схему:", e);
    process.exit(1);
  });
