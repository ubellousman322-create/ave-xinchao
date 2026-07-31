const FLASH_DECAY       = 0.82;
const OBSESSION_GROWTH  = 1.10;
const PROMOTE_THRESHOLD = 0.50;
const PROMOTE_MIN_AGE   = 3;
const FEEDBACK_AMOUNT   = 0.18;
const FEEDBACK_CEIL     = 0.85;
const MAX_FEEDBACKS     = 3;
const MAX_FLASH         = 8;
const MAX_OBSESSIONS    = 3;
const MAX_CATCHUP_TICKS = 4096;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const bounded = (value, min = 0, max = 1) => Math.max(min, Math.min(max, finite(value)));

export function newThoughtPool() {
  return { flash: [], obsessions: [] };
}

function ensureThoughtPool(pool) {
  pool.flash = Array.isArray(pool.flash) ? pool.flash : [];
  pool.obsessions = Array.isArray(pool.obsessions) ? pool.obsessions : [];
  return pool;
}

function tickOnce(pool, feedbacks) {
  pool.flash = pool.flash
    .map((thought) => ({
      ...thought,
      intensity: bounded(finite(thought.intensity) * FLASH_DECAY),
      age: Math.max(0, Math.trunc(finite(thought.age))) + 1,
      occurrences: Math.max(1, Math.trunc(finite(thought.occurrences, 1))),
    }))
    .filter((thought) => thought.intensity > 0.05);

  const promoted = [];
  pool.flash = pool.flash.filter((thought) => {
    if (thought.intensity < PROMOTE_THRESHOLD || thought.age < PROMOTE_MIN_AGE) return true;
    const existing = pool.obsessions.find((item) => item.key === thought.key);
    if (existing) {
      existing.intensity = bounded(Math.max(finite(existing.intensity), thought.intensity) + thought.intensity * 0.20);
      existing.text = thought.text || existing.text || '';
      existing.occurrences = Math.max(1, Math.trunc(finite(existing.occurrences, 1))) + Math.max(1, thought.occurrences);
      return false;
    }
    if (pool.obsessions.length + promoted.length >= MAX_OBSESSIONS) return true;
    promoted.push({
      key: thought.key,
      text: thought.text || '',
      intensity: thought.intensity,
      feedbacks: 0,
      occurrences: Math.max(1, thought.occurrences),
    });
    return false;
  });
  pool.obsessions.push(...promoted);

  pool.obsessions = pool.obsessions
    .map((obsession) => {
      const next = {
        ...obsession,
        intensity: bounded(finite(obsession.intensity) * OBSESSION_GROWTH),
        feedbacks: Math.max(0, Math.trunc(finite(obsession.feedbacks))),
        occurrences: Math.max(1, Math.trunc(finite(obsession.occurrences, 1))),
      };
      if (next.intensity > FEEDBACK_CEIL && next.feedbacks < MAX_FEEDBACKS) {
        feedbacks[next.key] = (feedbacks[next.key] ?? 0) + FEEDBACK_AMOUNT;
        next.feedbacks += 1;
      }
      return next;
    })
    .filter((obsession) => obsession.feedbacks < MAX_FEEDBACKS);
}

export function tickThoughtPool(pool, ticks = 1) {
  ensureThoughtPool(pool);
  const count = Math.max(0, Math.min(MAX_CATCHUP_TICKS, Math.trunc(finite(ticks))));
  const feedbacks = {};
  for (let index = 0; index < count; index += 1) tickOnce(pool, feedbacks);
  return feedbacks;
}

export function addFlashThought(pool, key, text, intensity = 0.70) {
  ensureThoughtPool(pool);
  const normalizedKey = String(key ?? '').trim();
  if (!normalizedKey) return;
  const normalizedText = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const incoming = bounded(intensity);
  const existing = pool.flash.find((thought) => thought.key === normalizedKey);
  if (existing) {
    const previous = bounded(existing.intensity);
    existing.intensity = bounded(Math.max(previous, incoming) + Math.min(previous, incoming) * 0.25);
    existing.text = normalizedText || existing.text || '';
    existing.occurrences = Math.max(1, Math.trunc(finite(existing.occurrences, 1))) + 1;
    return;
  }
  if (pool.flash.length >= MAX_FLASH) {
    pool.flash.sort((left, right) => finite(left.intensity) - finite(right.intensity));
    pool.flash.shift();
  }
  pool.flash.push({ key: normalizedKey, text: normalizedText, intensity: incoming, age: 0, occurrences: 1 });
}

export function obsessionBonus(pool, key) {
  const hit = (pool?.obsessions ?? []).find((obsession) => obsession.key === key);
  return hit ? bounded(hit.intensity) * 0.15 : 0;
}
