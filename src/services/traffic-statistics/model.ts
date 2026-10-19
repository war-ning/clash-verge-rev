export type Dimension = 'target' | 'process' | 'group'
export type Metric = 'total' | 'download' | 'upload'
type Route = 'direct' | 'proxy' | 'unknown'

export interface Identity {
  target: string | null
  process: string | null
  path: string | null
  group: string | null
  route: Route
  unattributed: boolean
}

export interface TrafficRecord extends Identity {
  at: number
  upload: number
  download: number
}

export interface Coverage {
  start: number
  end: number
  offset: number
  consistent: boolean
}

export interface StatisticsSettings {
  enabled: boolean
  retentionDays: number
  recordTargets: boolean
  recordProcesses: boolean
}

export interface StatisticsSnapshot {
  records: TrafficRecord[]
  coverage: Coverage[]
  groups: string[]
  settings: StatisticsSettings
  warnings: string[]
  savedAt: number
  collecting: boolean
  durable: boolean
}

export interface Query {
  start: number
  end: number
  timezone: string
  groups: string[] | null
  search: string
  dimension: Dimension
  metric: Metric
  order: 'default' | 'name' | 'ascending'
  focus?: { dimension: Dimension; key: string }
  interval?: { start: number; end: number }
}

export interface Ranking {
  key: string
  identity: Identity
  label: string | null
  upload: number
  download: number
  special: boolean
}
