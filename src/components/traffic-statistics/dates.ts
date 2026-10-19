import type { Query } from '@/services/traffic-statistics/model'

export function calendarDate(time: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(time)
  const part = (type: string) =>
    parts.find((value) => value.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export const dateInput = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export function dateRange(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00`)
  const last = new Date(`${endDate}T00:00:00`)
  if (dateInput(start) !== startDate || dateInput(last) !== endDate) return null
  const calendarDays =
    (Date.UTC(last.getFullYear(), last.getMonth(), last.getDate()) -
      Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
      86_400_000 +
    1
  if (!Number.isFinite(calendarDays) || calendarDays < 1 || calendarDays > 366)
    return null
  last.setDate(last.getDate() + 1)
  return { start: start.getTime(), end: last.getTime() }
}

export function presetRange(days: number) {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - days + 1)
  return dateRange(dateInput(start), dateInput(end))!
}

export const initialQuery = (): Query => ({
  ...presetRange(1),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  groups: null,
  search: '',
  dimension: 'target',
  metric: 'total',
  order: 'default',
})
