import { describe, expect, it, vi } from 'vitest'

import { calendarDate, dateRange } from './dates'

describe('statistics calendar boundaries', () => {
  it('keeps applied date labels tied to the query timezone', () => {
    const instant = Date.parse('2026-10-19T00:30:00Z')
    expect(calendarDate(instant, 'America/Los_Angeles')).toBe('2026-10-18')
    expect(calendarDate(instant, 'Asia/Shanghai')).toBe('2026-10-19')
  })
  it('rejects invalid and reversed dates while allowing 366 inclusive calendar days', () => {
    expect(dateRange('2026-02-29', '2026-03-01')).toBeNull()
    expect(dateRange('2026-10-20', '2026-10-19')).toBeNull()
    expect(dateRange('2024-01-01', '2024-12-31')).not.toBeNull()
    expect(dateRange('2024-01-01', '2025-01-01')).toBeNull()
  })

  it('uses calendar midnights across daylight-saving changes', () => {
    vi.stubEnv('TZ', 'America/New_York')
    try {
      const spring = dateRange('2026-03-08', '2026-03-08')!
      const fall = dateRange('2026-11-01', '2026-11-01')!
      expect(spring.end - spring.start).toBe(23 * 3_600_000)
      expect(fall.end - fall.start).toBe(25 * 3_600_000)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
