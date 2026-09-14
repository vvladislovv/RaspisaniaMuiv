import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  // Бинарник Chromium не бандлится через webpack — грузится с диска в рантайме
  serverExternalPackages: ['playwright-core', '@sparticuz/chromium'],
  // serverExternalPackages не спасает от трассировки файлов для serverless-бандла:
  // Vercel копирует в /var/task только то, что нашёл статическим анализом require(),
  // а chromium.executablePath() строит путь к бинарнику динамически — без явного
  // включения каталог bin/ в бандл не попадает и в проде падает с ENOENT.
  outputFileTracingIncludes: {
    '/api/tick': ['./node_modules/@sparticuz/chromium/bin/**'],
    // /api/bot тоже поднимает Chromium — сразу после выбора группы подтягивает
    // её расписание, не дожидаясь часового тика (см. ingestGroupNow)
    '/api/bot': ['./node_modules/@sparticuz/chromium/bin/**'],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          },
        ],
      },
    ];
  },
};

export default config;
