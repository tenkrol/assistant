/**
 * Rule-based fact detection: what the user says about themselves that is worth
 * keeping.
 *
 * The model already has the `remember` tool, but it only fires when it decides
 * to call it — and it sometimes answers "запомнил" in words instead. These
 * patterns catch the durable facts deterministically and cost no tokens.
 *
 * Rules are deliberately narrow: a wrong memory is worse than a missing one, so
 * only statements (never questions) and only well-known shapes are matched.
 */

/** One rule: a fact template plus the pattern that triggers it. */
const RULES = [
  { pattern: /(?:меня|его|её|ее)\s+зовут\s+([\p{L}-]{2,30})/iu, fact: (m) => `его зовут ${capitalize(m[1])}` },
  { pattern: /(?:моё|мое)\s+имя\s*[—:-]?\s*([\p{L}-]{2,30})/iu, fact: (m) => `его зовут ${capitalize(m[1])}` },
  { pattern: /(?:я|мы)\s+живу?\s+в\s+([\p{L}\s-]{3,40})/iu, fact: (m) => `живёт в ${title(m[1])}` },
  { pattern: /мой\s+город\s*[—:-]\s*([\p{L}\s-]{3,40})/iu, fact: (m) => `его город — ${title(m[1])}` },
  { pattern: /(?:я|мы)\s+из\s+([\p{L}\s-]{3,40})/iu, fact: (m) => `родом из ${title(m[1])}` },
  { pattern: /(?:я\s+)?работаю\s+([\p{L}\s-]{3,60})/iu, fact: (m) => `работает ${m[1].trim()}` },
  { pattern: /мне\s+(\d{1,2})\s+(?:год|года|лет)/iu, fact: (m) => `${m[1]} лет` },
  { pattern: /(?:у\s+меня\s+есть\s+)((?:сын|дочь|жена|муж|кот|кошка|собака)[\p{L}\s-]{0,30})/iu, fact: (m) => `есть ${m[1].trim()}` },
  { pattern: /(?:я\s+)(вегетарианец|вегетарианка|аллергия на [\p{L}\s-]{3,30})/iu, fact: (m) => `он ${m[1].trim()}` },
]

const capitalize = (value) => value[0].toUpperCase() + value.slice(1)
const title = (value) => value.trim().split(/\s+/).map(capitalize).join(' ')

/**
 * Facts worth remembering from one message.
 *
 * @param {string} text - the user's message.
 * @returns {Array<{fact: string, city?: string}>} detected facts, possibly empty.
 */
export function detectFacts(text) {
  const value = String(text ?? '').trim()
  if (value === '' || value.endsWith('?')) return []
  // A long message is a story, not a fact statement; the model can still remember
  // from it using the `remember` tool.
  if (value.length > 300) return []
  const found = []
  for (const rule of RULES) {
    const match = rule.pattern.exec(value)
    if (!match) continue
    const fact = rule.fact(match)
    if (found.some((item) => item.fact.toLowerCase() === fact.toLowerCase())) continue
    // A city fact also becomes the default city for weather.
    // Only a nominative-looking name becomes the weather city: 'живу в Москве'
    // is a prepositional case and would break geocoding, so that one is left to
    // the model's remember tool, which passes the correct form.
    const cityRaw = /^живёт в (.+)$/.test(fact)
      ? fact.replace(/^живёт в /, '')
      : (/^его город — (.+)$/.test(fact) ? fact.replace(/^его город — /, '') : '')
    const city = cityRaw !== '' && !/[еыи]$/i.test(cityRaw) ? cityRaw : undefined
    found.push({ fact, ...(city ? { city } : {}) })
  }
  return found
}
