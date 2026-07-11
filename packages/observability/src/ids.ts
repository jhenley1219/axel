// Session ids become directory names — keep them filesystem-safe and bounded.
export const sanitizeSessionId = (id: string): string =>
  id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown'
