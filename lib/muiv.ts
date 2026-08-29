/**
 * Доступ к сайту muiv.ru через JS-защиту Bitrix.
 *
 * Сайт отдаёт HTML-заглушку с JS, который считает хеш от параметра из куки
 * `__js_p_` и ставит куки `__jhash_` / `__jua_`. Алгоритм детерминированный,
 * поэтому браузер не нужен — считаем тот же хеш на сервере.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

export const SCHEDULE_URL = 'https://www.muiv.ru/studentu/spo/raspisanie/';
const ALLOWED_HOST = 'www.muiv.ru';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 6;

/** Тот же расчёт, что в `get_jhash` на странице-заглушке. */
export function jhash(b: number): number {
  let x = 123456789;
  let k = 0;
  for (let i = 0; i < 1677696; i++) {
    x = ((x + b) ^ (x + (x % 3) + (x % 17) + b) ^ i) % 16776960;
    if (x % 117 === 0) k = (k + 1) % 1111;
  }
  return k;
}

/** `fixedEncodeURIComponent` со страницы-заглушки. */
function encodeUa(ua: string): string {
  return encodeURIComponent(ua).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16),
  );
}

function isChallenge(html: string): boolean {
  return html.includes('get_jhash') || html.includes('__jhash_');
}

function assertAllowed(url: string): URL {
  const u = new URL(url, SCHEDULE_URL);
  if (u.protocol !== 'https:' || u.hostname !== ALLOWED_HOST) {
    throw new Error(`Недопустимый хост: ${u.href}`);
  }
  return u;
}

/** Куки-джар на одну сессию обхода защиты. */
class Session {
  private jar = new Map<string, string>();

  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res: Response): void {
    const raw =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [];
    for (const cookie of raw) {
      const m = /^([^=]+)=([^;]*)/.exec(cookie);
      if (m) this.jar.set(m[1], m[2]);
    }
  }

  /** Ставит куки, которые обычно ставит JS в браузере. */
  solve(): void {
    const jsp = this.jar.get('__js_p_');
    if (!jsp) throw new Error('Сайт не выдал куку __js_p_ — защита изменилась');
    const code = Number.parseInt(jsp.split(',')[0], 10);
    if (!Number.isFinite(code)) throw new Error(`Неразборная кука __js_p_: ${jsp}`);
    this.jar.set('__jhash_', String(jhash(code)));
    this.jar.set('__jua_', encodeUa(UA));
  }

  async fetch(url: string, accept: string): Promise<Response> {
    const u = assertAllowed(url);
    const res = await fetch(u, {
      redirect: 'manual', // сайт после решения защиты редиректит на себя же
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'User-Agent': UA,
        Accept: accept,
        'Accept-Language': 'ru-RU,ru;q=0.9',
        Cookie: this.header(),
      },
    });
    this.absorb(res);
    return res;
  }
}

const MAX_REDIRECTS = 4;
const SESSION_RETRIES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Одна попытка пройти защиту. Редиректы не тратят попытки решения задачи:
 * после установки куки сайт отвечает 302 на тот же URL, и это нормальный шаг.
 */
async function tryOpenSession(): Promise<{ session: Session; html: string } | string> {
  const session = new Session();
  const trace: string[] = [];
  let redirects = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await session.fetch(SCHEDULE_URL, 'text/html,application/xhtml+xml,*/*');
    } catch (error) {
      // Обрыв соединения или таймаут — это повод попробовать ещё раз,
      // а не уронить всю проверку
      const cause = (error as { cause?: { code?: string } })?.cause?.code;
      return `сеть недоступна: ${cause ?? (error instanceof Error ? error.message : String(error))}`;
    }

    while (res.status >= 300 && res.status < 400) {
      trace.push(`${res.status}`);
      if (++redirects > MAX_REDIRECTS) return `слишком много редиректов (${trace.join(',')})`;
      try {
        res = await session.fetch(SCHEDULE_URL, 'text/html,application/xhtml+xml,*/*');
      } catch (error) {
        const cause = (error as { cause?: { code?: string } })?.cause?.code;
        return `сеть недоступна на редиректе: ${cause ?? String(error)}`;
      }
    }

    if (!res.ok) return `сайт ответил ${res.status} (${trace.join(',')})`;

    const html = await res.text();
    trace.push(`${res.status}/${html.length}`);

    if (!isChallenge(html)) return { session, html };

    try {
      session.solve();
    } catch (error) {
      return `${error instanceof Error ? error.message : String(error)} (${trace.join(',')})`;
    }

    // Сайт иногда отдаёт заглушку повторно — небольшая пауза помогает
    await sleep(250 * attempt);
  }

  return `защита не пройдена за ${MAX_ATTEMPTS} попыток (${trace.join(',')})`;
}

/** Проходит защиту, при неудаче начинает заново с чистой сессией. */
async function openSession(): Promise<{ session: Session; html: string }> {
  const failures: string[] = [];

  for (let round = 1; round <= SESSION_RETRIES; round++) {
    const outcome = await tryOpenSession();
    if (typeof outcome !== 'string') return outcome;

    failures.push(`сессия ${round}: ${outcome}`);
    if (round < SESSION_RETRIES) await sleep(1500 * round);
  }

  throw new Error(`Не удалось пройти JS-защиту сайта. ${failures.join('; ')}`);
}

export interface SiteFile {
  url: string;
  title: string;
  /** «Дата обновления» как её показывает сайт, например «25.08.2026». */
  siteUpdated: string | null;
  /** Размер как его показывает сайт, например «59,09 кБ». */
  siteSize: string | null;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Достаёт список файлов расписания из HTML страницы. */
export function parseFileList(html: string): SiteFile[] {
  const files: SiteFile[] = [];
  const seen = new Set<string>();

  const linkRe = /<a[^>]+href="([^"]*\/upload\/[^"]*\.xlsx?)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const m of html.matchAll(linkRe)) {
    const href = m[1];
    if (seen.has(href)) continue;
    seen.add(href);

    const title = stripTags(m[2]) || href.split('/').pop() || href;

    // «Дата обновления» и размер лежат в разметке рядом со ссылкой.
    // Теги снимаем до поиска, иначе разметка внутри строки рвёт дату.
    const tail = stripTags(html.slice(m.index + m[0].length, m.index + m[0].length + 900));
    const updated = /Дата обновления:\s*(\d{2}\.\d{2}\.\d{4})/.exec(tail);
    const size = /(\d+[,.]?\d*\s*(?:кБ|КБ|Кб|МБ|Мб|kB|MB))/.exec(tail);

    files.push({
      url: new URL(href, SCHEDULE_URL).href,
      title,
      siteUpdated: updated ? updated[1] : null,
      siteSize: size ? size[1].replace(/\s+/g, ' ') : null,
    });
  }

  return files;
}

export interface SiteSnapshot {
  files: SiteFile[];
  download(file: SiteFile): Promise<Buffer>;
}

/** Открывает сессию, читает список файлов и даёт возможность их скачать. */
export async function fetchSite(): Promise<SiteSnapshot> {
  const { session, html } = await openSession();
  const files = parseFileList(html);

  return {
    files,
    async download(file: SiteFile): Promise<Buffer> {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await session.fetch(
          file.url,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*',
        );

        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) throw new Error('Редирект без Location');
          assertAllowed(loc); // редирект на чужой хост — отказ
          continue;
        }

        if (!res.ok) throw new Error(`Файл ${file.title}: HTTP ${res.status}`);

        const type = res.headers.get('content-type') ?? '';
        if (type.includes('text/html')) {
          session.solve(); // снова заглушка — решаем защиту и пробуем ещё раз
          continue;
        }

        const declared = Number(res.headers.get('content-length') ?? '0');
        if (declared > MAX_FILE_BYTES) {
          throw new Error(`Файл ${file.title} слишком большой: ${declared} байт`);
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > MAX_FILE_BYTES) {
          throw new Error(`Файл ${file.title} слишком большой: ${buf.byteLength} байт`);
        }
        if (buf.byteLength < 1024 || buf.readUInt16BE(0) !== 0x504b) {
          throw new Error(`Файл ${file.title} не похож на xlsx (нет ZIP-подписи)`);
        }
        return buf;
      }
      throw new Error(`Не удалось скачать ${file.title}`);
    },
  };
}
