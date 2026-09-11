/**
 * Headless Chromium для доступа к muiv.ru.
 *
 * Сайт закрыт WAF по фингерпринту клиента: даже корректно решённая JS-задача
 * `get_jhash`/`__jhash_` не пускает обычный `fetch`/`curl` — сервер каждый раз
 * отдаёт одну и ту же заглушку. Настоящий браузер проходит сразу, без заглушки,
 * поэтому вместо повторной реализации защиты поднимаем настоящий Chromium и
 * делаем запросы из его контекста — с тем же фингерпринтом, что и у обычного
 * посетителя.
 */
import chromium from '@sparticuz/chromium';
import { chromium as playwright, type Page } from 'playwright-core';

const NAV_TIMEOUT_MS = 20_000;

/**
 * Сколько ждать, пока заглушка `get_jhash` сама себя посчитает и уйдёт
 * редиректом на настоящую страницу — расчёт хеша (см. `lib/muiv.ts`, тот же
 * алгоритм) занимает заметное время в браузерном JS, `page.goto` возвращает
 * управление сразу после загрузки самой заглушки, а не после редиректа.
 */
const CHALLENGE_TIMEOUT_MS = 15_000;

export interface BrowserSession {
  page: Page;
}

/**
 * Запускает браузер, один раз заходит на `url` (это и проходит защиту — она
 * встроена в саму страницу и решается её собственным JS), отдаёт сессию в
 * колбэк и гарантированно закрывает браузер после — иначе процесс Chromium не
 * даст serverless-функции корректно завершиться.
 */
export async function withBrowserSession<T>(
  url: string,
  fn: (session: BrowserSession) => Promise<T>,
): Promise<T> {
  // Бинарник @sparticuz/chromium собран под Amazon Linux (среда Vercel/Lambda)
  // и не запустится локально на macOS/обычном Linux — там нужен свой Chromium
  // (например, поставленный `npx playwright install chromium`), путь к нему
  // задаётся через CHROMIUM_EXECUTABLE_PATH.
  const local = process.env.CHROMIUM_EXECUTABLE_PATH;
  const browser = await playwright.launch({
    args: local ? [] : chromium.args,
    executablePath: local || (await chromium.executablePath()),
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });
    await waitOutChallenge(page);
    return await fn({ page });
  } finally {
    await browser.close();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ждёт, пока заглушка-задача сама уйдёт редиректом на настоящую страницу.
 * Опрос вместо `waitForNavigation`: момент самого редиректа непредсказуем
 * (зависит от того, как быстро браузер посчитает хеш), и легко проверить
 * состояние уже после того, как он случился, чем поймать точный момент.
 */
async function waitOutChallenge(page: Page): Promise<void> {
  const hasChallenge = () =>
    page.evaluate(() => document.body.innerHTML.includes('get_jhash')).catch(() => false);

  const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;
  while (await hasChallenge()) {
    if (Date.now() > deadline) {
      throw new Error('Сайт не пропустил через JS-защиту: заглушка не редиректнула на реальную страницу');
    }
    await sleep(300);
  }
}

/**
 * POST на `ajax.php` из контекста страницы — теми же куками и фингерпринтом,
 * что и у обычного посетителя. Обычный `page.request` (вне рендерера) сюда не
 * годится: WAF отличает его от запроса, сделанного самой страницей.
 */
export async function postAjax(
  page: Page,
  body: Record<string, string>,
): Promise<Record<string, string>> {
  return page.evaluate(
    async ({ body }) => {
      const res = await fetch('/services/timetable/ajax.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body,
      });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`ajax.php вернул не JSON: ${text.slice(0, 200)}`);
      }
    },
    { body: new URLSearchParams(body).toString() },
  );
}
