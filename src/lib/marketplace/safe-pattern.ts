type Atom = (character: string) => boolean
type Token = { atom: Atom; min: number; max: number | null }

const MAX_PATTERN_LENGTH = 256
const MAX_VALUE_LENGTH = 2048
const MAX_EXPLICIT_REPETITIONS = 4096

function builtinClass(code: string): Atom | null {
  if (code === 'd') return character => character >= '0' && character <= '9'
  if (code === 'D') return character => character < '0' || character > '9'
  if (code === 'w') return character => /[A-Za-z0-9_]/.test(character)
  if (code === 'W') return character => !/[A-Za-z0-9_]/.test(character)
  if (code === 's') return character => character === ' ' || character === '\t'
  if (code === 'S') return character => character !== ' ' && character !== '\t'
  return null
}

function literal(character: string): Atom {
  return candidate => candidate === character
}

function parseClass(pattern: string, start: number): { atom: Atom; next: number } | null {
  let cursor = start + 1
  let negated = false
  if (pattern[cursor] === '^') { negated = true; cursor++ }
  const atoms: Atom[] = []
  let pending: string | null = null
  const pushPending = () => { if (pending !== null) { atoms.push(literal(pending)); pending = null } }

  while (cursor < pattern.length && pattern[cursor] !== ']') {
    let character = pattern[cursor++]
    if (character === '\\') {
      if (cursor >= pattern.length) return null
      const escaped = pattern[cursor++]
      const classAtom = builtinClass(escaped)
      if (classAtom) { pushPending(); atoms.push(classAtom); continue }
      if (!'\\[]^-'.includes(escaped)) return null
      character = escaped
    }
    if (character === '-' && pending !== null && cursor < pattern.length && pattern[cursor] !== ']') {
      let end = pattern[cursor++]
      if (end === '\\') {
        if (cursor >= pattern.length) return null
        end = pattern[cursor++]
        if (!'\\[]^-'.includes(end)) return null
      }
      if (pending.codePointAt(0)! > end.codePointAt(0)!) return null
      const from = pending.codePointAt(0)!
      const to = end.codePointAt(0)!
      atoms.push(candidate => {
        const code = candidate.codePointAt(0)!
        return code >= from && code <= to
      })
      pending = null
      continue
    }
    pushPending()
    pending = character
  }
  pushPending()
  if (pattern[cursor] !== ']' || atoms.length === 0) return null
  return { atom: character => negated !== atoms.some(test => test(character)), next: cursor + 1 }
}

function parsePattern(rawPattern: string): Token[] | null {
  if (rawPattern.length > MAX_PATTERN_LENGTH || /[^\x20-\x7e]/.test(rawPattern)) return null
  let pattern = rawPattern
  if (pattern.startsWith('^')) pattern = pattern.slice(1)
  if (pattern.endsWith('$') && !pattern.endsWith('\\$')) pattern = pattern.slice(0, -1)
  const tokens: Token[] = []
  let cursor = 0
  let repetitionBudget = 0

  while (cursor < pattern.length) {
    let atom: Atom
    const character = pattern[cursor++]
    if (character === '[') {
      const parsed = parseClass(pattern, cursor - 1)
      if (!parsed) return null
      atom = parsed.atom
      cursor = parsed.next
    } else if (character === '\\') {
      if (cursor >= pattern.length) return null
      const escaped = pattern[cursor++]
      atom = builtinClass(escaped) ?? literal(escaped)
      if (!builtinClass(escaped) && !'\\.[]{}?*+()|^$-/'.includes(escaped)) return null
    } else if (character === '.') {
      atom = () => true
    } else {
      if ('()|{}?*+^$]'.includes(character)) return null
      atom = literal(character)
    }

    let min = 1
    let max: number | null = 1
    const quantifier = pattern[cursor]
    if (quantifier === '?' || quantifier === '*' || quantifier === '+') {
      cursor++
      if (quantifier === '?') { min = 0; max = 1 }
      if (quantifier === '*') { min = 0; max = null }
      if (quantifier === '+') { min = 1; max = null }
    } else if (quantifier === '{') {
      const end = pattern.indexOf('}', cursor + 1)
      if (end === -1) return null
      const body = pattern.slice(cursor + 1, end)
      const match = /^(\d{1,4})(?:,(\d{0,4}))?$/.exec(body)
      if (!match) return null
      min = Number(match[1])
      max = match[2] === undefined ? min : match[2] === '' ? null : Number(match[2])
      if (min > MAX_VALUE_LENGTH || (max !== null && (max > MAX_VALUE_LENGTH || max < min))) return null
      cursor = end + 1
    }
    const explicit = max ?? min
    repetitionBudget += explicit
    if (repetitionBudget > MAX_EXPLICIT_REPETITIONS) return null
    tokens.push({ atom, min, max })
  }
  return tokens
}

function consumeOnce(previous: boolean[], characters: string[], atom: Atom) {
  const next = new Array<boolean>(characters.length + 1).fill(false)
  for (let position = 1; position <= characters.length; position++) {
    next[position] = previous[position - 1] && atom(characters[position - 1])
  }
  return next
}

function consumeUnbounded(previous: boolean[], characters: string[], atom: Atom) {
  const next = [...previous]
  for (let position = 1; position <= characters.length; position++) {
    if (next[position - 1] && atom(characters[position - 1])) next[position] = true
  }
  return next
}

export function isSafeParameterPattern(pattern: string) {
  return parsePattern(pattern) !== null
}

/** Deterministic dynamic programming matcher; never constructs a RegExp. */
export function matchesSafeParameterPattern(pattern: string, value: string) {
  if (value.length > MAX_VALUE_LENGTH) return false
  const tokens = parsePattern(pattern)
  if (!tokens) return false
  const characters = Array.from(value)
  if (characters.length > MAX_VALUE_LENGTH) return false
  let reachable = new Array<boolean>(characters.length + 1).fill(false)
  reachable[0] = true

  for (const token of tokens) {
    for (let count = 0; count < token.min; count++) reachable = consumeOnce(reachable, characters, token.atom)
    if (token.max === null) {
      reachable = consumeUnbounded(reachable, characters, token.atom)
      continue
    }
    const accepted = [...reachable]
    for (let count = token.min; count < token.max; count++) {
      reachable = consumeOnce(reachable, characters, token.atom)
      for (let position = 0; position < accepted.length; position++) accepted[position] ||= reachable[position]
    }
    reachable = accepted
  }
  return reachable[characters.length]
}

