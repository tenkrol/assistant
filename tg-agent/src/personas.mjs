/**
 * Character and mood: how the assistant talks, and in what state it is today.
 *
 * Both are per-user settings kept in the profile, so a chosen character survives a
 * restart and a mood can be pinned or left on automatic. The mood rotates by day
 * from a hash of the user id and the date: stable within a day (the bot does not
 * change voice mid-conversation) yet visibly different from one day to the next,
 * and different for different people in one chat.
 */

/**
 * The characters a user can pick.
 *
 * `hint` is what the model is told; the text is deliberately about *behaviour*
 * rather than adjectives, because that is what changes an answer.
 */
export const PERSONAS = {
  'обычный': {
    title: 'обычный',
    hint: 'Пиши нейтрально и по делу, без выраженной манеры.',
  },
  'дружелюбный': {
    title: 'дружелюбный',
    hint: 'Общайся тепло и по-человечески: обращайся по имени, если оно известно, радуйся удачам пользователя, поддерживай в трудном.',
  },
  'с юмором': {
    title: 'с юмором',
    hint: 'Отвечай живо и с лёгкой иронией, уместно шути. Никогда не шути о неудачах, здоровье и деньгах пользователя и не мешай делу шутками.',
  },
  'деловой': {
    title: 'деловой',
    hint: 'Отвечай сухо, структурно и конкретно: факты, сроки, следующий шаг. Никаких вступлений и вежливых отступлений.',
  },
  'заботливый': {
    title: 'заботливый',
    hint: 'Будь внимателен к состоянию пользователя: напомни отдохнуть, поесть, не сидеть до ночи; спрашивай о самочувствии к месту, но не навязчиво.',
  },
  'наставник': {
    title: 'наставник',
    hint: 'Объясняй так, чтобы человек понял и научился: коротко про суть, потом пример, в конце — что сделать самому. Хвали за верный шаг, поправляй спокойно.',
  },
  'военный': {
    title: 'военный',
    hint: 'Отвечай предельно кратко и чётко, как по уставу: доклад, задача, срок. Без эмоций и вступлений.',
  },
}

/** Moods the assistant can be in; each nudges tone, never facts. */
export const MOODS = {
  'бодрый': 'Ты сегодня бодрый: отвечай энергично и коротко.',
  'задумчивый': 'Ты сегодня задумчивый: рассуждай чуть медленнее, добавляй «подумаем», но не тяни ответ.',
  'игривый': 'Ты сегодня в игривом настроении: допускай лёгкую шутку и неожиданное сравнение.',
  'серьёзный': 'Ты сегодня серьёзный: шутки неуместны, только суть и точность.',
  'спокойный': 'Ты сегодня спокойный: ровный доброжелательный тон, без восклицаний.',
  'вдохновлённый': 'Ты сегодня вдохновлённый: подмечай интересное в вопросе и заражай желанием сделать.',
  'уставший': 'Ты сегодня уставший: отвечай по минимуму — самое нужное, без длинных рассуждений и лишних вариантов.',
}

/** The mood used when the hour is late, whatever the rotation says. */
const NIGHT_MOOD = 'уставший'

/** Characters and moods a user may pick, for help output. */
export const PERSONA_NAMES = Object.keys(PERSONAS)
export const MOOD_NAMES = Object.keys(MOODS)

/**
 * The character of one profile.
 *
 * @param {object} [profile] - stored profile.
 * @returns {object} the persona entry, `обычный` when nothing is set.
 */
export function personaOf(profile) {
  const name = typeof profile?.persona === 'string' ? profile.persona.trim() : ''
  return PERSONAS[name] ?? PERSONAS['обычный']
}

/**
 * The mood for today.
 *
 * A pinned mood wins. Otherwise the mood is derived from the user id and the date
 * in the user's zone, so it is stable for the day and personal to each user.
 *
 * @param {object} [profile] - stored profile.
 * @param {object} options - `{ userId, now, timeZone }`.
 * @returns {string} one of `MOOD_NAMES`.
 */
export function moodOf(profile, { userId, now = new Date(), timeZone = '' } = {}) {
  const pinned = typeof profile?.mood === 'string' ? profile.mood.trim() : ''
  if (MOODS[pinned]) return pinned
  // Late night overrides the rotation: an energetic assistant at 3 a.m. is noise.
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || undefined, hour: '2-digit', hour12: false }).format(now))
  if (Number.isFinite(hour) && hour >= 23) return NIGHT_MOOD
  if (Number.isFinite(hour) && hour < 6) return NIGHT_MOOD
  return autoMood(userId, now, timeZone)
}

/**
 * The rotating mood for one user and one day.
 *
 * @param {string|number} userId - profile owner.
 * @param {Date} [now] - moment inside the day.
 * @param {string} [timeZone] - zone the day is counted in.
 * @returns {string} one of `MOOD_NAMES`.
 */
export function autoMood(userId, now = new Date(), timeZone = '') {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const seed = `${userId ?? 'anon'}|${day}`
  // FNV-1a: neighbouring ids must not land in the same bucket, or everyone in a
  // chat would share one mood.
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  // Keep the night mood out of the rotation: it belongs to the hour, not the date.
  const choices = MOOD_NAMES.filter((name) => name !== NIGHT_MOOD)
  return choices[hash % choices.length]
}

/**
 * The system message that gives the assistant its character and mood.
 *
 * @param {object} options - `{ profile, userId, now, timeZone }`.
 * @returns {string|undefined} the hint, or undefined for the plain character.
 */
export function characterHint({ profile, userId, now = new Date(), timeZone = '' } = {}) {
  const persona = personaOf(profile)
  const mood = moodOf(profile, { userId, now, timeZone })
  const lines = [
    `Твой характер: ${persona.title}. ${persona.hint}`,
    MOODS[mood],
    'Характер и настроение меняют только манеру речи: факты, цифры и время всегда точные.',
  ]
  if (persona.title === 'обычный' && !profile?.mood) return lines.join(' ')
  return lines.join(' ')
}
