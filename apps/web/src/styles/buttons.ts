// Shared button style utilities — keep visual appearance in sync across components.

/**
 * Returns inline styles for the primary action button.
 * `disabled` drives both colours and cursor.
 * Optional `fullWidth` adds `width: '100%'` (used by LockScreen).
 */
export const primaryBtnStyle = (
  disabled: boolean,
  opts: { fullWidth?: boolean; borderRadius?: string } = {},
): React.CSSProperties => ({
  background: disabled ? '#1a1a1a' : '#1e3a8a',
  border: `1px solid ${disabled ? '#333' : '#3b82f6'}`,
  borderRadius: opts.borderRadius ?? '6px',
  padding: '0.75rem 1rem',
  color: disabled ? '#555' : '#f0f0f0',
  fontSize: '0.9rem',
  cursor: disabled ? 'not-allowed' : 'pointer',
  whiteSpace: 'nowrap' as const,
  ...(opts.fullWidth ? { width: '100%', boxSizing: 'border-box' as const } : {}),
  transition: 'background 0.2s',
})
