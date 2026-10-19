import type {
  Coverage,
  Dimension,
  Identity,
  Metric,
  Query,
  Ranking,
  StatisticsSnapshot,
  TrafficRecord,
} from './model'

export const HOUR = 3_600_000

export const amount = (
  value: { upload: number; download: number },
  metric: Metric,
) => (metric === 'total' ? value.upload + value.download : value[metric])

export const identityKey = (identity: Identity, dimension: Dimension) =>
  JSON.stringify(
    identity.unattributed
      ? ['unattributed']
      : dimension === 'process'
        ? [identity.process, identity.path]
        : [identity[dimension]],
  )

const identityLabel = (identity: Identity, dimension: Dimension) =>
  dimension === 'process'
    ? (identity.process ?? identity.path)
    : identity[dimension]

export function coveredDuration(
  coverage: Coverage[],
  start: number,
  end: number,
) {
  const ranges = coverage
    .filter(
      (range) => range.consistent && range.end > start && range.start < end,
    )
    .map((range) => [Math.max(start, range.start), Math.min(end, range.end)])
    .sort((a, b) => a[0] - b[0])
  let duration = 0
  let cursor = start
  for (const [left, right] of ranges) {
    duration += Math.max(0, right - Math.max(left, cursor))
    cursor = Math.max(cursor, right)
  }
  return duration
}

export function rank(records: TrafficRecord[], query: Query): Ranking[] {
  const entries = new Map<string, Ranking>()
  for (const record of records) {
    const key = identityKey(record, query.dimension)
    const previous = entries.get(key)
    if (previous) {
      previous.upload += record.upload
      previous.download += record.download
    } else {
      entries.set(key, {
        key,
        identity: record,
        label: identityLabel(record, query.dimension),
        upload: record.upload,
        download: record.download,
        special:
          record.unattributed ||
          identityLabel(record, query.dimension) === null,
      })
    }
  }
  return [...entries.values()].sort((left, right) => {
    const name =
      (left.label ?? '').localeCompare(right.label ?? '') ||
      left.key.localeCompare(right.key)
    if (query.order === 'name') return name
    const difference = amount(right, query.metric) - amount(left, query.metric)
    return (query.order === 'ascending' ? -difference : difference) || name
  })
}

export function analyze(snapshot: StatisticsSnapshot, query: Query) {
  const start = Math.max(query.start, query.interval?.start ?? query.start)
  const end = Math.min(query.end, query.interval?.end ?? query.end)
  const periodRecords = snapshot.records.filter(
    (record) => record.at >= start && record.at < end,
  )
  const search = query.search.trim().toLocaleLowerCase()
  const records = periodRecords.filter((record) => {
    if (
      query.groups !== null &&
      (record.group === null || !query.groups.includes(record.group))
    )
      return false
    if (
      search &&
      ![record.target, record.process, record.path, record.group].some(
        (value) => value?.toLocaleLowerCase().includes(search),
      )
    )
      return false
    return (
      !query.focus ||
      identityKey(record, query.focus.dimension) === query.focus.key
    )
  })
  const totals = records.reduce(
    (sum, record) => ({
      upload: sum.upload + record.upload,
      download: sum.download + record.download,
    }),
    { upload: 0, download: 0 },
  )
  const buckets: {
    start: number
    end: number
    upload: number
    download: number
    covered: number
    records: TrafficRecord[]
  }[] = []
  const byHour = new Map<number, TrafficRecord[]>()
  for (const record of records) {
    const bucketStart = start + Math.floor((record.at - start) / HOUR) * HOUR
    const hour = byHour.get(bucketStart) ?? []
    hour.push(record)
    byHour.set(bucketStart, hour)
  }
  for (let cursor = start; cursor < end; cursor += HOUR) {
    const bucketEnd = Math.min(cursor + HOUR, end)
    const bucketRecords = byHour.get(cursor) ?? []
    buckets.push({
      start: cursor,
      end: bucketEnd,
      upload: bucketRecords.reduce((sum, record) => sum + record.upload, 0),
      download: bucketRecords.reduce((sum, record) => sum + record.download, 0),
      covered: coveredDuration(snapshot.coverage, cursor, bucketEnd),
      records: bucketRecords,
    })
  }
  return {
    query,
    records,
    totals,
    ranking: rank(records, query),
    buckets,
    covered: coveredDuration(snapshot.coverage, start, end),
    periodHasRecords: periodRecords.length > 0,
    ungroupedExcluded:
      query.groups !== null &&
      periodRecords.some((record) => record.group === null),
  }
}

export function exportAnalysis(snapshot: StatisticsSnapshot, query: Query) {
  if (!snapshot.durable)
    throw new Error(
      'Refresh after the statistics save failure is resolved before exporting',
    )
  const result = analyze(snapshot, query)
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    savedAt: snapshot.savedAt,
    collectionSettings: snapshot.settings,
    collecting: snapshot.collecting,
    units: 'integer bytes',
    shareDenominator: amount(result.totals, query.metric),
    scope:
      'Managed direct and proxy traffic; not a provider bill. Sample-end minute attribution, displayed hourly or daily.',
    warnings: snapshot.warnings,
    coverage: snapshot.coverage.filter(
      (range) =>
        range.end >
          Math.max(query.start, query.interval?.start ?? query.start) &&
        range.start < Math.min(query.end, query.interval?.end ?? query.end),
    ),
    ...result,
  }
}
