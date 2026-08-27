import type { Metadata } from 'next';
import { Unbounded, Golos_Text, JetBrains_Mono } from 'next/font/google';
import './globals.css';

/*
  Все три гарнитуры — с кириллицей и российского происхождения:
  Unbounded для вывески, Golos Text для текста, JetBrains Mono для времени,
  размеров и хешей. Шрифты хостятся вместе с приложением, поэтому CSP
  ограничен собственным доменом.
*/
const display = Unbounded({
  subsets: ['cyrillic', 'latin'],
  weight: ['600', '700'],
  variable: '--font-display',
  display: 'swap',
});

const body = Golos_Text({
  subsets: ['cyrillic', 'latin'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['cyrillic', 'latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Расписание МУИВ — статус бота',
  description: 'Когда сайт МУИВ обновлял расписание и что бот с этим сделал.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
