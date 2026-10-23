/** Как показывать людей владельцу: в заявках, списках доступа и обратной связи. */

/** Расстояние редактирования: сколько правок отделяет одну строку от другой. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length);

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }

  return previous[b.length];
}

/**
 * Имя и юзернейм — про одного и того же человека?
 *
 * Люди ставят имя почти как юзернейм и делают опечатки: «Deviil_clown03» при
 * «@Devil_clown03». Точное сравнение такое не поймает, поэтому допускаем
 * пару правок — но только на достаточно длинных строках, чтобы не склеить
 * действительно разные короткие имена.
 */
function looksLikeSameHandle(name: string, handle: string): boolean {
  const plain = (value: string) => value.toLowerCase().replace(/[_\s.\-]/g, '');
  const a = plain(name);
  const b = plain(handle);

  if (a === b) return true;
  if (Math.min(a.length, b.length) < 6) return false;
  if (Math.abs(a.length - b.length) > 2) return false;

  return editDistance(a, b) <= 2;
}

/**
 * Как назвать человека в заявке.
 *
 * Имя в Telegram часто совпадает с юзернеймом («Deviil_clown03» и
 * «@Devil_clown03»), и печатать оба — значит показывать одно и то же дважды.
 * Поэтому сравниваем без учёта регистра и подчёркиваний.
 */
export function describeUser(user: {
  username?: string | null;
  first_name?: string | null;
  id?: number;
}): string {
  const name = user.first_name?.trim() || null;
  const handle = user.username?.trim() || null;

  if (handle && (!name || looksLikeSameHandle(name, handle))) return `@${handle}`;
  if (name && handle) return `${name} (@${handle})`;
  if (name) return name;
  return user.id ? `ID ${user.id}` : 'без имени';
}
