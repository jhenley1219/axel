// Spec §3.6 — line-based LCS diff (a = HEAD, b = working text)
export type DiffRow = { t: 'ctx' | 'del' | 'add'; s: string }

// LCS is O(m·n); past this the dp table gets too big — fall back to del-all/add-all
const MAX_CELLS = 4_000_000

export function diffLines(aText: string, bText: string): Array<DiffRow> {
  const A = aText.split('\n')
  const B = bText.split('\n')

  // Trim common prefix/suffix so typical small edits stay cheap
  let lo = 0
  while (lo < A.length && lo < B.length && A[lo] === B[lo]) lo++
  let aHi = A.length, bHi = B.length
  while (aHi > lo && bHi > lo && A[aHi - 1] === B[bHi - 1]) { aHi--; bHi-- }

  const head: Array<DiffRow> = A.slice(0, lo).map(s => ({ t: 'ctx', s }))
  const tail: Array<DiffRow> = A.slice(aHi).map(s => ({ t: 'ctx', s }))
  const a = A.slice(lo, aHi)
  const b = B.slice(lo, bHi)
  const m = a.length, n = b.length

  if (m * n > MAX_CELLS) {
    return [...head, ...a.map(s => ({ t: 'del' as const, s })), ...b.map(s => ({ t: 'add' as const, s })), ...tail]
  }

  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const mid: Array<DiffRow> = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { mid.push({ t: 'ctx', s: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { mid.push({ t: 'del', s: a[i] }); i++ }
    else { mid.push({ t: 'add', s: b[j] }); j++ }
  }
  while (i < m) mid.push({ t: 'del', s: a[i++] })
  while (j < n) mid.push({ t: 'add', s: b[j++] })

  return [...head, ...mid, ...tail]
}
