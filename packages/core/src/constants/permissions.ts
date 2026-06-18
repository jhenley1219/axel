// Deny list for bash tool — belt-and-suspenders against accidental destructive ops.
// Note: an allowlist of permitted command prefixes is the correct long-term fix (C-1).
// These patterns guard against the most common accidental-damage scenarios.
export const DENIED_PATTERNS: RegExp[] = [
  /\brm\b.*-[a-zA-Z]*r[a-zA-Z]*/,         // rm -r (any flag position)
  /\brm\b.*--recursive\b/,
  /\brm\b.*-[a-zA-Z]*f\s/,                  // rm -f file
  /\bmkfs\b/,
  /\bdd\b.*\bif=/i,
  /\bchmod\s+[0-7]*7[0-7]{2}\b/,            // chmod 7xx (world-writable)
  /\bchmod\s+[0-7]{2}7\b/,                  // chmod xx7
  /\bchmod\s+[auog]*\+[rwx]*w[rwx]*/,        // chmod +w for all/other
  />\s*\/dev\/[a-z]+\d*/,                   // redirect to device
  /\|\s*(?:ba)?sh\b/i,                       // pipe to shell
  /:\(\)\s*\{/,                              // fork bomb
]
