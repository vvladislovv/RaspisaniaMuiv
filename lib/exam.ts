/**
 * Зачёты и экзамены в расписании.
 *
 * Отдельного поля в файле МУИВ для них нет: колледж пишет «Экзамен» или
 * «Зачёт» прямо в ячейке пары, поэтому узнаём их по тексту.
 */
import type { Day, Lesson } from './parse';

export type ExamKind = 'exam' | 'credit';

/** Консультация перед экзаменом — это ещё не сам экзамен. */
const CONSULTATION = /консультац/i;
const EXAM = /экзамен/i;
// «зачёт» и «зачет», а также «дифзачёт» и «дифференцированный зачёт»
const CREDIT = /зач[её]т/i;

export function examKind(lesson: Lesson): ExamKind | null {
  const text = lesson.raw || lesson.subject;
  if (CONSULTATION.test(text)) return null;
  if (EXAM.test(text)) return 'exam';
  if (CREDIT.test(text)) return 'credit';
  return null;
}

/** Что отметить на дне: экзамен важнее зачёта. */
export function dayExamKind(day: Day): ExamKind | null {
  const kinds = day.lessons.map(examKind);
  if (kinds.includes('exam')) return 'exam';
  if (kinds.includes('credit')) return 'credit';
  return null;
}

export const EXAM_MARK: Record<ExamKind, { dot: string; label: string }> = {
  exam: { dot: '🔴', label: 'ЭКЗАМЕН' },
  credit: { dot: '🟡', label: 'ЗАЧЁТ' },
};
