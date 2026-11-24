export interface TrafficQuery {
  period: 'today' | 'hour' | 'week' | 'month'
  route: 'proxy' | 'direct' | 'unknown'
  search: string
  target: string | null
  byProcess: boolean
  metric: 'total' | 'upload' | 'download'
  page: number
}

export interface TargetRow {
  target: string
  upload: number
  download: number
  lastSeen: number
}

export interface DetailRow extends TargetRow {
  ip: string
  process: string
  path: string
  rule: string
  rulePayload: string
  chain: string
  route: string
}

export interface TrafficSnapshot {
  start: number
  end: number
  timezone: string
  collecting: boolean
  observedAt: number
  savedAt: number
  pending: boolean
  warning: string | null
  totals: { upload: number; download: number }
  targets: TargetRow[]
  matchedTargets: number
  details: DetailRow[]
  matchedDetails: number
  daily: { date: string; upload: number; download: number }[]
  gapMillis: number
  databaseBytes: number
}

export const initialQuery = (): TrafficQuery => ({
  period: 'today',
  route: 'proxy',
  search: '',
  target: null,
  byProcess: true,
  metric: 'total',
  page: 0,
})
