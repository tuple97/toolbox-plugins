/**
 * 最小 ZIP 写入器。
 *
 * 为什么不用 archiver / jszip：插件包的产出是发布流水线的关键路径，
 * 这里只需要「把若干文件按目录结构装进一个 zip」这一件事，
 * 自实现（约 150 行）比引入依赖更可控 —— 没有额外供应链面，
 * 且 CI 与本地行为完全一致。
 *
 * 实现覆盖 PKZIP 的最小可用子集：deflate（方法 8）与 store（方法 0）、
 * UTF-8 文件名、单一 central directory，不含 zip64（插件包远小于 4GB）。
 */

import { deflateRawSync } from 'node:zlib'

/** CRC32 查表（多项式 0xEDB88320） */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[i] = c >>> 0
  }
  return table
})()

/** 计算 CRC32 */
function crc32(buffer) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8)
  }
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** 把 Date 编码成 DOS 时间/日期 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: day }
}

/**
 * 打包成 zip。
 *
 * @param {Array<{ name: string, data: Buffer | string }>} entries
 *        条目列表；name 为 zip 内路径（使用正斜杠）
 * @param {{ modified?: Date }} [options]
 * @returns {Buffer}
 */
export function createZip(entries, options = {}) {
  const { time, date } = dosDateTime(options.modified ?? new Date())

  const localChunks = []
  const centralChunks = []
  let offset = 0

  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/')
    const nameBuffer = Buffer.from(name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const crc = crc32(raw)

    const compressed = deflateRawSync(raw, { level: 9 })
    // 压缩后更大时退回 store，避免「越压越大」
    const useDeflate = compressed.length < raw.length
    const payload = useDeflate ? compressed : raw
    const method = useDeflate ? 8 : 0

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed
    localHeader.writeUInt16LE(0x0800, 6) // flags: UTF-8 文件名
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(time, 10)
    localHeader.writeUInt16LE(date, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(payload.length, 18)
    localHeader.writeUInt32LE(raw.length, 22)
    localHeader.writeUInt16LE(nameBuffer.length, 26)
    localHeader.writeUInt16LE(0, 28) // extra length

    localChunks.push(localHeader, nameBuffer, payload)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(time, 12)
    centralHeader.writeUInt16LE(date, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(raw.length, 24)
    centralHeader.writeUInt16LE(nameBuffer.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra
    centralHeader.writeUInt16LE(0, 32) // comment
    centralHeader.writeUInt16LE(0, 34) // disk start
    centralHeader.writeUInt16LE(0, 36) // internal attrs
    centralHeader.writeUInt32LE(0, 38) // external attrs
    centralHeader.writeUInt32LE(offset, 42) // local header offset

    centralChunks.push(centralHeader, nameBuffer)

    offset += localHeader.length + nameBuffer.length + payload.length
  }

  const centralBuffer = Buffer.concat(centralChunks)
  const centralOffset = offset

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localChunks, centralBuffer, eocd])
}

export default createZip
