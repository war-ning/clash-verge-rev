/** 与 Rust 侧 `module/traffic_stats.rs` 中的保留 key 一一对应。 */
export const OTHER_KEY = '__other__'
export const UNATTRIBUTED_KEY = '__unattributed__'
export const UNKNOWN_KEY = '__unknown__'

/** 展示哪一路数值。 */
export type TrafficMetric = 'total' | 'up' | 'down'

const AGGREGATE_KEYS = new Set([OTHER_KEY, UNATTRIBUTED_KEY, UNKNOWN_KEY])

export const isAggregateKey = (key: string) =>
  AGGREGATE_KEYS.has(key.split('\u0001')[0])

export const metricValue = (
  entry: { up: number; down: number },
  metric: TrafficMetric,
) => {
  if (metric === 'up') return entry.up
  if (metric === 'down') return entry.down
  return entry.up + entry.down
}

/**
 * 按黄金角步进分配色相，保证相邻项差异明显且同一 index 永远同色。
 */
export const colorForIndex = (index: number, dark: boolean) => {
  const hue = Math.round((210 + index * 137.508) % 360)
  return dark ? `hsl(${hue} 62% 60%)` : `hsl(${hue} 56% 46%)`
}

/** 聚合项（其他 / 未归因 / 未知）统一用中性灰，避免和真实节点抢眼。 */
export const colorForAggregate = (key: string, dark: boolean) => {
  if (key === UNATTRIBUTED_KEY) return dark ? 'hsl(0 0% 42%)' : 'hsl(0 0% 72%)'
  return dark ? 'hsl(0 0% 55%)' : 'hsl(0 0% 60%)'
}
