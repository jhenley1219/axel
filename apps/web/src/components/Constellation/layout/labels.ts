// Label anti-collision: given N items evenly distributed on a ring of radius R,
// the screen-space gap between adjacent labels is the chord length 2R·sin(π/N).
// Each label's text is bounded so its pixel width stays inside that gap (minus
// PAD_PX of breathing room), preventing the labels from running into each
// other regardless of where the ring's current rotation has parked them.

const AVG_CHAR_PX = 5.3   // Space Mono at 8–8.5px font, with .04em letter-spacing
const PAD_PX      = 12    // breathing room between adjacent labels — tighter = more crashes
const MIN_CHARS   = 3     // never collapse a label to nothing
const HARD_CAP    = 18    // even with infinite arc, don't sprawl

export function labelCapacity(itemCount: number, radius: number, maxWidthPx?: number): number {
  // Angular (chord) cap — keeps within-band labels from running into each other
  // around their shared ring at their shared radius.
  let chordCap = HARD_CAP
  if (itemCount > 1 && radius > 0) {
    const chord = 2 * radius * Math.sin(Math.PI / itemCount)
    chordCap = Math.floor((chord - PAD_PX) / AVG_CHAR_PX)
  }
  // Radial (lane) cap — keeps horizontal label width from bleeding past the
  // band's allowed orbital range into the next lane. Caller passes the lane's
  // full horizontal allowance (2× half-width) in pixels.
  const widthCap = maxWidthPx !== undefined
    ? Math.floor((maxWidthPx - PAD_PX) / AVG_CHAR_PX)
    : HARD_CAP
  return Math.max(MIN_CHARS, Math.min(HARD_CAP, chordCap, widthCap))
}

// Smart truncation that keeps the extension when there is one — recognisable
// filenames matter more than a clean trailing character. Used as the
// last-resort fallback when token-aware fitInCap can't help.
export function truncateName(name: string, maxChars: number): string {
  if (name.length <= maxChars) return name
  if (maxChars <= 3) return name.slice(0, Math.max(1, maxChars))
  const dot = name.lastIndexOf('.')
  if (dot > 4 && dot >= name.length - 6) {
    const ext  = name.slice(dot)
    const keep = Math.max(1, maxChars - ext.length - 1)
    return name.slice(0, keep) + '…' + ext
  }
  return name.slice(0, maxChars - 1) + '…'
}

// ── DISTINGUISHING-WORD LABELS ─────────────────────────────────────────────
//
// When a group of filenames share a naming convention (common prefix, common
// suffix, or both), the truncation that "fits" geometrically often produces
// labels that look identical — e.g. "rta-bluepr…", "rtg-bluepr…", which is
// useless. This pair of helpers reframes the problem:
//
//   1. distinguishingLabels(names) — find tokens shared by EVERY name and
//      strip them, leaving each name's unique tokens. Tokens are separated by
//      `-`, `_`, `.` (extension), and camelCase boundaries (including the
//      acronym-then-lower case "APIClient" → "API" + "Client").
//
//   2. fitInCap(label, maxChars) — drops trailing tokens at word boundaries
//      until the label fits. Never truncates inside a word. If a single word
//      is longer than the cap, the whole word is shown (overflows the lane,
//      but a meaningful word beats "blu…").
//
// The hover overlay (LabelOverlay.tsx) is the escape hatch for users who need
// to see the full name when at-rest truncation hides too much context.

const SEP_RE = /[-_.]/

function isUpper(c: string): boolean { return c >= 'A' && c <= 'Z' }
function isLower(c: string): boolean { return c >= 'a' && c <= 'z' }

// A token is "weak" when stripping the common prefix and leaving only this
// behind would produce a meaningless label — e.g. "1", "2", "a". User asked
// for "rta-1" / "rta-2", not bare "1" / "2".
function isWeakToken(t: string): boolean {
  return t.length <= 1 || /^\d+$/.test(t)
}

// Split a string into word-level tokens. Recognises:
//   - separator chars (-, _, .) as token boundaries (consumed, not kept)
//   - lowercase→Uppercase: "useAuth" → "use", "Auth"
//   - acronym→lower: "APIClient" → "API", "Client" (split before the LAST
//     uppercase of a run when followed by a lowercase)
function splitTokens(s: string): Array<string> {
  const out: Array<string> = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (SEP_RE.test(c)) {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    if (i > 0) {
      const prev = s[i - 1]
      // lower→Upper boundary, push then start new
      if (isLower(prev) && isUpper(c)) {
        if (cur) out.push(cur)
        cur = c
        continue
      }
      // ACRONYM→lower: ...AB|c — move last char of cur into the new token
      if (i > 1 && isUpper(prev) && isUpper(s[i - 2]) && isLower(c) && cur.length > 1) {
        const tail = cur.slice(-1)
        out.push(cur.slice(0, -1))
        cur = tail + c
        continue
      }
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

type Parsed = { name: string; stem: string; ext: string; tokens: Array<string> }

function parse(name: string): Parsed {
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0 && dot < name.length - 1 && /^\.[a-z0-9]+$/i.test(name.slice(dot))
  const stem = hasExt ? name.slice(0, dot) : name
  const ext  = hasExt ? name.slice(dot) : ''
  return { name, stem, ext, tokens: splitTokens(stem) }
}

// Rebuild a partial label from a name's stem and a prefix of its tokens,
// preserving the original separator characters that sat between those tokens
// in the source string (so kebab stays kebab, camelCase stays camel, etc.).
function buildLabel(stem: string, tokens: Array<string>): string {
  if (tokens.length === 0) return ''
  let label = ''
  let cursor = 0
  for (const tok of tokens) {
    const at = stem.indexOf(tok, cursor)
    if (at < 0) { label += (label ? '-' : '') + tok; continue }
    if (label) {
      const between = stem.slice(cursor, at)
      label += between + tok
    } else {
      label = tok
    }
    cursor = at + tok.length
  }
  return label
}

// Compute a display label per name such that EVERY result is distinct from
// every other (case-sensitive — so "RTA" and "rta" can sit side-by-side).
//
// Strategy: strip universally common tokens (and shared extension) FIRST so
// boilerplate doesn't bloat the labels; then for each name walk progressively
// longer prefixes of its remaining tokens until its label disagrees with what
// every other name would show at the same prefix length. Two `rta-bedroom` /
// `rta-office` peers can no longer collapse to a shared "rta" — they extend
// past the collision until they diverge.
//
// `maxChars` is a SOFT cap: if applying fitInCap to the unique form keeps
// every label distinct from every other (capped or not), the capped form is
// used; otherwise the longer, unique form wins (overflow accepted — the
// hover-label overlay surfaces the full name on demand).
// `reservedNames` are labels owned by some OTHER renderer (e.g. the parent
// dir's own name, or the dir orbiters on the same ring) that the labels
// produced here must NOT exactly match. Reservation participates in collision
// detection only — it does NOT contribute to common-token stripping. A parent
// dir "rta" added as reservation must not disqualify "outdoor" from the common
// set of files [outdoor-kitchen, outdoor-living]; that would un-strip
// "outdoor" from the file labels and bloat them with no benefit. Shared
// extension stripping likewise applies only to the real-name group, but it is
// disabled when dropping the ext would create a stem-equal collision with a
// reserved name (file "rta-bp-component.tsx" vs reserved dir "rta-bp-component")
// so file-vs-dir stays distinguishable.
export function uniqueLabels(
  names: Array<string>,
  maxChars?: number,
  reservedNames: ReadonlyArray<string> = [],
): Array<string> {
  if (names.length === 0) return []
  // Single name with no reservation to dodge → trivial path.
  if (names.length === 1 && reservedNames.length === 0) {
    const only = names[0]
    return [maxChars !== undefined ? fitInCap(only, maxChars) : only]
  }
  const parsed = names.map(parse)

  // Case-insensitive token intersection across every REAL name (reserved
  // names excluded — see the function header for why).
  const lowerSets = parsed.map(p => new Set(p.tokens.map(t => t.toLowerCase())))
  const common = new Set<string>()
  if (lowerSets.length > 0) {
    for (const t of lowerSets[0]) {
      if (lowerSets.every(s => s.has(t))) common.add(t)
    }
  }
  let sharedExt = parsed.length > 0 && parsed[0].ext !== '' && parsed.every(p => p.ext === parsed[0].ext)
  if (sharedExt && reservedNames.length > 0) {
    const stems = new Set(parsed.map(p => p.stem))
    if (reservedNames.some(r => stems.has(r))) sharedExt = false
  }

  // Effective tokens per name (universally-common tokens stripped). Three
  // fallback cases keep the label meaningful:
  //   - Empty after stripping → use full tokens (e.g. "package" against
  //     "package-lock" needs the bare "package" to stay).
  //   - All remaining tokens are "weak" (pure digits or single char) → keep
  //     the full tokens so "rta-1" / "rta-2" beats "1" / "2".
  const effective = parsed.map(p => {
    const filtered = p.tokens.filter(t => !common.has(t.toLowerCase()))
    if (filtered.length === 0) return p.tokens.slice()
    if (filtered.every(isWeakToken)) return p.tokens.slice()
    return filtered
  })

  // Build the SHORTEST unique label per name by progressive prefix extension.
  // We compare against the label other names would show at the SAME prefix
  // length (clamped to their token count), which mirrors how the user will
  // see the final result. Reserved names compare at their full raw form — we
  // can't know exactly what the other renderer will print after its own
  // stripping/capping, so the raw name is the conservative target.
  const unique: Array<string> = parsed.map((p, i) => {
    const myEff = effective[i]
    const myExt = sharedExt ? '' : p.ext
    let chosen = buildLabel(p.stem, myEff) + myExt   // fallback: all tokens

    for (let n = 1; n <= myEff.length; n++) {
      const my = buildLabel(p.stem, myEff.slice(0, n)) + myExt
      let collides = false
      for (let j = 0; j < parsed.length; j++) {
        if (j === i) continue
        const otherEff  = effective[j]
        const otherStem = parsed[j].stem
        const otherExt  = sharedExt ? '' : parsed[j].ext
        const otherN    = Math.min(n, otherEff.length)
        const other     = buildLabel(otherStem, otherEff.slice(0, otherN)) + otherExt
        if (other === my) { collides = true; break }
      }
      if (!collides) {
        for (let k = 0; k < reservedNames.length; k++) {
          if (reservedNames[k] === my) { collides = true; break }
        }
      }
      chosen = my
      if (!collides) break
    }
    return chosen
  })

  if (maxChars === undefined) return unique

  // Soft cap pass — fitInCap each label, but if capping any label causes it
  // to match another (real or reserved, capped or uncapped) label, keep the
  // uncapped form.
  const capped = unique.map(u => fitInCap(u, maxChars))
  const reservedCapped = reservedNames.map(r => fitInCap(r, maxChars))
  return capped.map((c, i) => {
    for (let j = 0; j < capped.length; j++) {
      if (i === j) continue
      if (capped[j] === c || unique[j] === c) return unique[i]
    }
    for (let j = 0; j < reservedCapped.length; j++) {
      if (reservedCapped[j] === c || reservedNames[j] === c) return unique[i]
    }
    return c
  })
}

// Greedy fit: keep the longest prefix of tokens that stays within maxChars.
// Never truncates inside a word; if even the first token is too long, returns
// the first token whole (overflow accepted to preserve readability).
export function fitInCap(label: string, maxChars: number): string {
  if (label.length <= maxChars) return label
  // Separate extension so we can decide whether to keep it on the truncated form
  const dot = label.lastIndexOf('.')
  const hasExt = dot > 0 && dot < label.length - 1 && /^\.[a-z0-9]+$/i.test(label.slice(dot))
  const stem = hasExt ? label.slice(0, dot) : label
  const ext  = hasExt ? label.slice(dot) : ''
  const tokens = splitTokens(stem)
  if (tokens.length === 0) return label

  if (tokens.length === 1) {
    // Single word longer than the cap — show the whole word; drop the ext if
    // including it would just push us further over.
    if (stem.length + ext.length <= maxChars) return stem + ext
    return stem
  }

  // Walk forward through stem, accumulating tokens (with their original
  // separators) until appending the next would exceed the cap.
  let acc = tokens[0]
  let cursor = stem.indexOf(tokens[0]) + tokens[0].length
  for (let i = 1; i < tokens.length; i++) {
    const at  = stem.indexOf(tokens[i], cursor)
    if (at < 0) break
    const sep = stem.slice(cursor, at)
    const candidate = acc + sep + tokens[i]
    if (candidate.length + ext.length > maxChars) break
    acc = candidate
    cursor = at + tokens[i].length
  }
  // Append extension only if it fits; otherwise drop it (the colored dot
  // already encodes the type).
  return acc.length + ext.length <= maxChars ? acc + ext : acc
}
