/** Чтение и проверка переменных окружения. Секреты не логируются нигде. */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Не задана переменная окружения ${name}`);
  }
  return value.trim();
}

function optional(name: string): string | null {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : null;
}

export const env = {
  get botToken() {
    return required('TELEGRAM_BOT_TOKEN');
  },
  get webhookSecret() {
    return required('TELEGRAM_WEBHOOK_SECRET');
  },
  get cronSecret() {
    return required('CRON_SECRET');
  },
  get supabaseUrl() {
    return required('SUPABASE_URL');
  },
  get supabaseServiceKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY');
  },
  get adminTelegramId() {
    const raw = required('ADMIN_TELEGRAM_ID');
    const id = Number(raw);
    if (!Number.isSafeInteger(id)) throw new Error('ADMIN_TELEGRAM_ID должен быть числом');
    return id;
  },
  /** Если задан — статус-страница требует `?t=<токен>`. */
  get statusToken() {
    return optional('STATUS_TOKEN');
  },
  /** Час МСК для автоотправки. По умолчанию 16. */
  get sendHourMsk() {
    const raw = optional('SEND_HOUR_MSK');
    const hour = raw === null ? 16 : Number(raw);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error('SEND_HOUR_MSK должен быть целым числом 0–23');
    }
    return hour;
  },
  get publicBaseUrl() {
    return optional('PUBLIC_BASE_URL') ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  },
};
