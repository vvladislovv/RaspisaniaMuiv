/**
 * Минимальная распаковка ZIP через node:zlib.
 *
 * xlsx — это ZIP с записями, сжатыми raw deflate (метод 8) или без сжатия (метод 0).
 * Читаем central directory с конца файла — так надёжнее, чем идти по локальным
 * заголовкам, потому что в них может не быть настоящих размеров.
 */
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

function findEocd(buf: Buffer): number {
  const from = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('ZIP: не найден end-of-central-directory');
}

/** Возвращает содержимое всех записей архива. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const out = new Map<string, Buffer>();

  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(offset) !== CD_SIG) {
      throw new Error(`ZIP: битая запись каталога #${i}`);
    }

    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new Error(`ZIP: запись ${name} слишком большая (${uncompressedSize})`);
    }

    // Данные лежат после локального заголовка переменной длины
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      out.set(name, Buffer.from(raw));
    } else if (method === 8) {
      out.set(name, inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }));
    } else {
      throw new Error(`ZIP: неподдерживаемый метод сжатия ${method} у ${name}`);
    }
  }

  return out;
}
