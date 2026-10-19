import { describe, expect, it } from 'vitest'

import type { Query, StatisticsSnapshot, TrafficRecord } from './model'
import {
  analyze,
  coveredDuration,
  exportAnalysis,
  HOUR,
  identityKey,
} from './query'

const record = (overrides: Partial<TrafficRecord> = {}): TrafficRecord => ({
  at: 0,
  target: 'example.com',
  process: 'browser.exe',
  path: 'C:/one/browser.exe',
  group: 'Work',
  route: 'proxy',
  unattributed: false,
  upload: 10,
  download: 90,
  ...overrides,
})
const query: Query = {
  start: 0,
  end: 2 * HOUR,
  timezone: 'UTC',
  groups: null,
  search: '',
  dimension: 'process',
  metric: 'total',
  order: 'default',
}
const snapshot = (records: TrafficRecord[]): StatisticsSnapshot => ({
  records,
  coverage: [{ start: 0, end: HOUR, consistent: true, offset: 0 }],
  groups: ['Work', 'DIRECT'],
  settings: {
    enabled: true,
    retentionDays: 30,
    recordTargets: true,
    recordProcesses: true,
  },
  warnings: [],
  savedAt: HOUR,
  collecting: true,
  durable: true,
})

describe('statistics analysis accounting', () => {
  it('does not export records that could not be persisted', () => {
    const source = snapshot([record()])
    source.durable = false
    expect(() => exportAnalysis(source, query)).toThrow('save failure')
  })
  it('uses a group union for every view and excludes unassignable bytes', () => {
    const source = snapshot([
      record(),
      record({ group: 'DIRECT', download: 40 }),
      record({ group: null, unattributed: true, download: 200 }),
    ])
    const result = analyze(source, { ...query, groups: ['Work', 'DIRECT'] })
    expect(result.totals).toEqual({ upload: 20, download: 130 })
    expect(result.ranking[0].download).toBe(130)
    expect(
      result.buckets.reduce((sum, bucket) => sum + bucket.download, 0),
    ).toBe(130)
    expect(result.ungroupedExcluded).toBe(true)
    expect(analyze(source, { ...query, groups: [] }).records).toHaveLength(0)
    expect(analyze(source, query).totals.download).toBe(330)
  })

  it('separates same-name executables and drills down by exact identity', () => {
    const first = record()
    const source = snapshot([
      first,
      record({ path: 'C:/two/browser.exe' }),
      record({ path: null }),
    ])
    expect(analyze(source, query).ranking).toHaveLength(3)
    const focus = {
      dimension: 'process' as const,
      key: identityKey(first, 'process'),
    }
    expect(analyze(source, { ...query, focus }).records).toEqual([first])
    expect(
      analyze(source, { ...query, search: 'C:/two' }).records,
    ).toHaveLength(1)
  })

  it('aggregates the long tail before ranking and exports every matching tuple', () => {
    const source = snapshot(
      Array.from({ length: 80 }, (_, i) =>
        record({
          target: `host-${i}`,
          process: `process-${i}`,
          path: null,
          download: i,
        }),
      ).concat([
        record({ process: 'process-0', path: null, at: HOUR, download: 200 }),
      ]),
    )
    const result = analyze(source, query)
    expect(result.ranking[0].label).toBe('process-0')
    const exported = exportAnalysis(source, query)
    expect(exported.records).toHaveLength(81)
    expect(exported.ranking).toHaveLength(80)
    expect(exported.totals).toEqual(result.totals)
    expect(
      exported.buckets
        .map((bucket) => bucket.download)
        .reduce((a, b) => a + b, 0),
    ).toBe(result.totals.download)
  })

  it('keeps zero traffic distinct from missing sampling and does not double-count coverage', () => {
    const source = snapshot([])
    source.coverage.push({
      start: HOUR / 2,
      end: HOUR,
      consistent: true,
      offset: 0,
    })
    expect(coveredDuration(source.coverage, 0, 2 * HOUR)).toBe(HOUR)
    const result = analyze(source, query)
    expect(result.buckets).toHaveLength(2)
    expect(result.buckets[0].covered).toBe(HOUR)
    expect(result.buckets[1].covered).toBe(0)
    source.coverage[0].consistent = false
    expect(coveredDuration(source.coverage, 0, HOUR)).toBe(HOUR / 2)
  })
})
