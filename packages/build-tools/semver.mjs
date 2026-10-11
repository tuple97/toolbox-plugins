/**
 * 插件仓库侧的 SemVer 实现。
 *
 * 它是宿主 app/internal/semver 的忠实镜像：两侧必须对同一个约束文本给出
 * 完全一致的判断，否则会出现「构建期校验通过、安装期解析失败」这类
 * 只在用户机器上暴露的问题。
 *
 * 支持语法（与宿主一致）：
 *
 *   * 或空             任意版本
 *   1.2.3              精确匹配
 *   1.2.x / 1.x        前缀通配
 *   ^1.2.3             兼容升级（>=1.2.3 <2.0.0；0.x 按最左非零段收窄）
 *   ~1.2.3             补丁升级（>=1.2.3 <1.3.0）
 *   >=1.2.3 <2.0.0     空格连接为「与」
 *   ^1.0.0 || ^2.0.0   用 || 连接为「或」
 */

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析版本号；非法时返回 null */
export function parseVersion(raw) {
  if (typeof raw !== 'string') {
    return null
  }
  const match = VERSION_RE.exec(raw.trim())
  if (!match) {
    return null
  }
  const [, major, minor, patch, pre] = match
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    pre: pre ? pre.split('.') : [],
    raw: raw.trim(),
  }
}

/** 版本号是否合法 */
export function isValidVersion(raw) {
  return parseVersion(raw) !== null
}

/** 比较两个版本：负数/0/正数 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) {
    throw new Error(`无法比较的版本号: ${left} / ${right}`)
  }
  return compareParsed(a, b)
}

function compareParsed(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) {
      return a[key] < b[key] ? -1 : 1
    }
  }
  return comparePrerelease(a.pre, b.pre)
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) {
    return 0
  }
  // 有预发布段的版本小于没有预发布段的版本
  if (a.length === 0) {
    return 1
  }
  if (b.length === 0) {
    return -1
  }
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) {
      return -1
    }
    if (right === undefined) {
      return 1
    }
    if (left === right) {
      continue
    }
    const leftNum = /^\d+$/.test(left)
    const rightNum = /^\d+$/.test(right)
    if (leftNum && rightNum) {
      return Number(left) < Number(right) ? -1 : 1
    }
    if (leftNum !== rightNum) {
      // 数字标识小于字母标识
      return leftNum ? -1 : 1
    }
    return left < right ? -1 : 1
  }
  return 0
}

/**
 * 解析约束表达式。
 *
 * @returns {{ groups: Array<Array<{op: string, version: object}>>, raw: string } | null}
 *          解析失败返回 null
 */
export function parseConstraint(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '' || text === '*' || text === 'x' || text === 'X') {
    return { groups: [], raw: '*' }
  }

  const groups = []
  for (const orPart of text.split('||')) {
    const group = parseAndGroup(orPart.trim())
    if (!group) {
      return null
    }
    groups.push(group)
  }
  if (groups.length === 0) {
    return null
  }
  return { groups, raw: text }
}

function parseAndGroup(text) {
  if (text === '') {
    return null
  }
  const fields = text.split(/\s+/).filter(Boolean)
  if (fields.length === 0) {
    return null
  }
  const group = []
  for (const field of fields) {
    const items = expandToken(field)
    if (!items) {
      return null
    }
    group.push(...items)
  }
  return group
}

function splitOp(token) {
  for (const op of ['>=', '<=', '~>', '>', '<', '=', '^', '~']) {
    if (token.startsWith(op)) {
      return { op, rest: token.slice(op.length).trim() }
    }
  }
  return { op: '', rest: token }
}

function parseLoose(text) {
  const value = text.trim()
  if (value === '') {
    return null
  }
  const parts = value.split('.')
  let normalized = value
  if (parts.length === 1) {
    normalized = `${value}.0.0`
  }
  else if (parts.length === 2) {
    normalized = `${value}.0`
  }
  const parsed = parseVersion(normalized)
  if (!parsed) {
    return null
  }
  return { major: parsed.major, minor: parsed.minor, patch: parsed.patch, pre: parsed.pre }
}

function caretUpper(version) {
  if (version.major > 0) {
    return { major: version.major + 1, minor: 0, patch: 0, pre: [] }
  }
  if (version.minor > 0) {
    return { major: 0, minor: version.minor + 1, patch: 0, pre: [] }
  }
  return { major: 0, minor: 0, patch: version.patch + 1, pre: [] }
}

function tildeUpper(version) {
  if (version.minor === 0 && version.patch === 0 && version.pre.length === 0) {
    return { major: version.major + 1, minor: 0, patch: 0, pre: [] }
  }
  return { major: version.major, minor: version.minor + 1, patch: 0, pre: [] }
}

function expandToken(token) {
  if (token === '') {
    return null
  }
  const { op, rest } = splitOp(token)
  switch (op) {
    case '^': {
      const version = parseLoose(rest)
      if (!version) {
        return null
      }
      return [
        { op: '>=', version },
        { op: '<', version: caretUpper(version) },
      ]
    }
    case '~':
    case '~>': {
      const version = parseLoose(rest)
      if (!version) {
        return null
      }
      return [
        { op: '>=', version },
        { op: '<', version: tildeUpper(version) },
      ]
    }
    case '>':
    case '>=':
    case '<':
    case '<=':
    case '=': {
      const version = parseLoose(rest)
      if (!version) {
        return null
      }
      return [{ op, version }]
    }
    default:
      return expandPlain(token)
  }
}

function expandPlain(token) {
  if (/[xX*]/.test(token)) {
    const parts = token.split('.')
    while (parts.length < 3) {
      parts.push('x')
    }
    return expandWildcard(parts.join('.'))
  }
  const parts = token.split('.')
  if (parts.length === 3) {
    const version = parseLoose(token)
    return version ? [{ op: '=', version }] : null
  }
  if (parts.length === 2) {
    return expandWildcard(`${token}.x`)
  }
  if (parts.length === 1) {
    return expandWildcard(`${token}.x.x`)
  }
  return null
}

function isWild(segment) {
  return segment === 'x' || segment === 'X' || segment === '*'
}

function expandWildcard(token) {
  const parts = token.split('.')
  if (parts.length !== 3) {
    return null
  }
  const num = (text) => (/^\d+$/.test(text) ? Number(text) : null)

  if (isWild(parts[0])) {
    return []
  }
  if (isWild(parts[1])) {
    const major = num(parts[0])
    if (major === null) {
      return null
    }
    return [
      { op: '>=', version: { major, minor: 0, patch: 0, pre: [] } },
      { op: '<', version: { major: major + 1, minor: 0, patch: 0, pre: [] } },
    ]
  }
  if (isWild(parts[2])) {
    const major = num(parts[0])
    const minor = num(parts[1])
    if (major === null || minor === null) {
      return null
    }
    return [
      { op: '>=', version: { major, minor, patch: 0, pre: [] } },
      { op: '<', version: { major, minor: minor + 1, patch: 0, pre: [] } },
    ]
  }
  const version = parseLoose(token)
  return version ? [{ op: '=', version }] : null
}

function referencesPrerelease(constraintVersion, version) {
  return constraintVersion.pre.length > 0
    && constraintVersion.major === version.major
    && constraintVersion.minor === version.minor
    && constraintVersion.patch === version.patch
}

function comparatorMatches(comparator, version) {
  // 预发布版本只在区间显式引用同版本预发布时才匹配（与 npm 语义一致）
  if (version.pre.length > 0 && !referencesPrerelease(comparator.version, version)) {
    return false
  }
  const result = compareParsed(version, comparator.version)
  switch (comparator.op) {
    case '=':
      return result === 0
    case '>':
      return result > 0
    case '>=':
      return result >= 0
    case '<':
      return result < 0
    case '<=':
      return result <= 0
    default:
      return false
  }
}

/** 版本是否满足约束文本 */
export function satisfies(versionText, constraintText) {
  const version = parseVersion(versionText)
  if (!version) {
    return false
  }
  const constraint = parseConstraint(constraintText)
  if (!constraint) {
    return false
  }
  if (constraint.groups.length === 0) {
    return true
  }
  return constraint.groups.some((group) => {
    if (group.length === 0) {
      return true
    }
    return group.every((comparator) => comparatorMatches(comparator, version))
  })
}

export default { parseVersion, isValidVersion, compareVersions, parseConstraint, satisfies }
