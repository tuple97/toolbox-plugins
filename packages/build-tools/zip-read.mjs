/**
 * 最小 ZIP 读取器：只做一件事 —— 列出包内条目名。
 *
 * 发布校验需要回答「这个 zip 里到底有哪些文件」，用中央目录解析即可，
 * 不需要解压数据，也避免了为此引入一个压缩库依赖。
 */

/** 读取 zip 的全部条目名（正斜杠路径，按名称排序） */
export function listZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('不是合法的 zip 内容（长度不足）')
  }

  const eocdOffset = findEndOfCentralDirectory(buffer)
  if (eocdOffset < 0) {
    throw new Error('不是合法的 zip 内容（未找到中央目录结束记录）')
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10)
  const centralSize = buffer.readUInt32LE(eocdOffset + 12)
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16)
  if (centralOffset + centralSize > buffer.length) {
    throw new Error('zip 中央目录越界，文件可能已损坏')
  }

  const names = []
  let cursor = centralOffset
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > buffer.length) {
      throw new Error('zip 中央目录记录不完整')
    }
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('zip 中央目录记录签名不正确')
    }
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const nameStart = cursor + 46
    if (nameStart + nameLength > buffer.length) {
      throw new Error('zip 条目名越界')
    }
    names.push(buffer.subarray(nameStart, nameStart + nameLength).toString('utf8'))
    cursor = nameStart + nameLength + extraLength + commentLength
  }
  return names.sort()
}

/** 从尾部向前查找 EOCD 签名 */
function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - 0xFFFF)
  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      return i
    }
  }
  return -1
}

export default listZipEntries
