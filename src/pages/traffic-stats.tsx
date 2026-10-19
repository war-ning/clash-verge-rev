import {
  DeleteSweepRounded,
  FileDownloadOutlined,
  RefreshRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  LinearProgress,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  TextField,
  Typography,
  useTheme,
} from '@mui/material'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { useDebounce, useLockFn } from 'ahooks'
import dayjs from 'dayjs'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { mutate } from 'swr'

import {
  BaseDialog,
  BaseEmpty,
  BasePage,
  BaseStyledSelect,
} from '@/components/base'
import {
  colorForAggregate,
  colorForIndex,
  isAggregateKey,
  metricValue,
  OTHER_KEY,
  UNATTRIBUTED_KEY,
  UNKNOWN_KEY,
  type TrafficMetric,
} from '@/components/traffic-stats/shared'
import { StackedBarChart } from '@/components/traffic-stats/stacked-bar-chart'
import { StatsTable } from '@/components/traffic-stats/stats-table'
import { useTrafficStats } from '@/hooks/use-traffic-stats'
import { useVerge } from '@/hooks/use-verge'
import { clearTrafficStats, exportTrafficStats } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import type { TranslationKey } from '@/types/generated/i18n-keys'
import parseTraffic from '@/utils/parse-traffic'

type RangePreset = 'today' | 'week' | 'month' | 'custom'
const CHART_SERIES = 8
const formatBytes = (value: number) => parseTraffic(value).join(' ')
const basename = (value: string) => value.split(/[\\/]/).pop() || value
const resolveRange = (preset: Exclude<RangePreset, 'custom'>) => ({
  startMs: dayjs()
    .subtract(preset === 'today' ? 0 : preset === 'week' ? 6 : 29, 'day')
    .startOf('day')
    .valueOf(),
  endMs: dayjs().add(1, 'day').startOf('day').valueOf(),
  granularity: (preset === 'today' ? 'hour' : 'day') as TrafficStatsGranularity,
})

const TrafficStatsPage = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const { verge } = useVerge()
  const [rangeState, setRangeState] = useState(() => ({
    preset: 'today' as RangePreset,
    ...resolveRange('today'),
  }))
  const [customStart, setCustomStart] = useState(() =>
    dayjs().format('YYYY-MM-DD'),
  )
  const [customEnd, setCustomEnd] = useState(() => dayjs().format('YYYY-MM-DD'))
  const [dimension, setDimension] = useState<TrafficStatsDimension>('host')
  const [metric, setMetric] = useState<TrafficMetric>('total')
  const [groups, setGroups] = useState<string[]>([])
  const [aggregate, setAggregate] = useState(true)
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounce(search.trim(), { wait: 250 })
  const [showAll, setShowAll] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const query = useMemo<ITrafficStatsQuery>(
    () => ({
      dimension,
      startMs: rangeState.startMs,
      endMs: rangeState.endMs,
      granularity: rangeState.granularity,
      topN: showAll ? undefined : 50,
      groups,
      metric,
      search: debouncedSearch,
      aggregate,
    }),
    [
      dimension,
      rangeState,
      showAll,
      groups,
      metric,
      debouncedSearch,
      aggregate,
    ],
  )
  const { stats, loading, error, refetch } = useTrafficStats(query)
  const totals = useMemo(() => stats?.totals ?? [], [stats])
  const buckets = useMemo(() => stats?.buckets ?? [], [stats])
  // Keep selected values visible even when a different period has no matching group.
  const allGroups = useMemo(
    () => [...new Set([...(stats?.groups ?? []), ...groups])].sort(),
    [stats, groups],
  )
  const isDark = theme.palette.mode === 'dark'
  const aggregateLabel = useCallback(
    (value: string) => {
      if (value === OTHER_KEY) return t('trafficStats.keys.other')
      if (value === UNATTRIBUTED_KEY) return t('trafficStats.keys.unattributed')
      if (value === UNKNOWN_KEY) return t('trafficStats.keys.unknown')
      return value
    },
    [t],
  )
  const displayName = useCallback(
    (entry: ITrafficStatsEntry) => {
      if (entry.name === UNKNOWN_KEY)
        return t(
          dimension === 'process'
            ? 'trafficStats.keys.unknownProcess'
            : dimension === 'host'
              ? 'trafficStats.keys.unknownHost'
              : 'trafficStats.keys.unknownGroup',
        )
      return dimension === 'process'
        ? basename(aggregateLabel(entry.name))
        : aggregateLabel(entry.name)
    },
    [aggregateLabel, dimension, t],
  )
  const displayGroup = useCallback(
    (entry: ITrafficStatsEntry) =>
      entry.group ? aggregateLabel(entry.group) : '',
    [aggregateLabel],
  )
  const displayProcess = useCallback(
    (entry: ITrafficStatsEntry) =>
      entry.process && entry.process !== UNKNOWN_KEY
        ? basename(entry.process)
        : '',
    [],
  )
  const colorMap = useMemo(() => {
    const map = new Map<string, string>()
    totals.forEach((entry, index) =>
      map.set(
        entry.key,
        isAggregateKey(entry.key)
          ? colorForAggregate(entry.key, isDark)
          : colorForIndex(index, isDark),
      ),
    )
    return map
  }, [totals, isDark])
  const colorOf = useCallback(
    (key: string) => colorMap.get(key) ?? colorForAggregate(key, isDark),
    [colorMap, isDark],
  )
  const entryByKey = useMemo(
    () => new Map(totals.map((entry) => [entry.key, entry])),
    [totals],
  )
  const chartLabelOf = useCallback(
    (key: string) => {
      const entry = entryByKey.get(key)
      return entry
        ? [displayName(entry), displayGroup(entry), displayProcess(entry)]
            .filter(Boolean)
            .join(' · ')
        : aggregateLabel(key)
    },
    [entryByKey, displayName, displayGroup, displayProcess, aggregateLabel],
  )
  const { chartKeys, chartBuckets } = useMemo(() => {
    const topKeys = totals
      .filter((entry) => !isAggregateKey(entry.key))
      .slice(0, CHART_SERIES)
      .map((entry) => entry.key)
    // Diagnostic categories must remain visible regardless of their rank.
    const kept = new Set([
      ...topKeys,
      ...totals
        .filter((entry) => isAggregateKey(entry.key))
        .map((entry) => entry.key),
    ])
    let overflow = false
    const mapped = buckets.map((bucket) => {
      const merged = new Map<string, ITrafficStatsEntry>()
      bucket.items.forEach((item) => {
        const key = kept.has(item.key) ? item.key : OTHER_KEY
        if (key === OTHER_KEY) overflow = true
        const current = merged.get(key)
        if (current) {
          current.up += item.up
          current.down += item.down
        } else
          merged.set(key, {
            ...item,
            key,
            name: key === OTHER_KEY ? OTHER_KEY : item.name,
          })
      })
      return { ...bucket, items: [...merged.values()] }
    })
    if (overflow) kept.add(OTHER_KEY)
    return { chartKeys: [...kept], chartBuckets: mapped }
  }, [totals, buckets])
  const grandTotal = totals.reduce(
    (sum, entry) => sum + metricValue(entry, metric),
    0,
  )
  const tableEntries = useMemo(
    () =>
      totals.map((entry) => ({
        ...entry,
        processPath: (dimension === 'process'
          ? entry.name
          : entry.process
        )?.match(/[\\/]/)
          ? dimension === 'process'
            ? entry.name
            : entry.process
          : undefined,
      })),
    [totals, dimension],
  )
  const selectRange = (preset: RangePreset) => {
    if (preset === 'custom')
      setRangeState((current) => ({ ...current, preset }))
    else setRangeState({ preset, ...resolveRange(preset) })
  }
  const customValid = Boolean(
    customStart &&
      customEnd &&
      dayjs(customStart).isValid() &&
      dayjs(customEnd).isValid() &&
      customEnd >= customStart &&
      dayjs(customEnd).diff(dayjs(customStart), 'day') < 366 &&
      customEnd <= dayjs().format('YYYY-MM-DD'),
  )
  const applyCustomRange = () => {
    if (!customValid) return
    setRangeState({
      preset: 'custom',
      startMs: dayjs(customStart).startOf('day').valueOf(),
      endMs: dayjs(customEnd).add(1, 'day').startOf('day').valueOf(),
      granularity: customStart === customEnd ? 'hour' : 'day',
    })
  }
  const handleRefresh = () => {
    if (rangeState.preset !== 'custom') {
      const next = resolveRange(rangeState.preset)
      if (
        next.startMs !== rangeState.startMs ||
        next.endMs !== rangeState.endMs
      ) {
        setRangeState({ preset: rangeState.preset, ...next })
        return
      }
    }
    void refetch().catch(showNotice.error)
  }
  const onExport = useLockFn(async () => {
    setExporting(true)
    try {
      const path = await saveDialog({
        defaultPath: `traffic-stats-${dimension}-${dayjs().format('YYYYMMDD-HHmm')}.xlsx`,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      })
      if (!path) return
      await exportTrafficStats({ ...query, topN: undefined }, path, {
        context: [
          t('trafficStats.notes.scope'),
          `${dayjs(query.startMs).format('YYYY-MM-DD')} — ${dayjs(query.endMs).subtract(1, 'day').format('YYYY-MM-DD')}`,
          t(`trafficStats.dimensions.${dimension}` as TranslationKey),
          t(`trafficStats.metrics.${metric}` as TranslationKey),
          t(
            aggregate
              ? 'trafficStats.filter.summary'
              : 'trafficStats.filter.detail',
          ),
          groups.length
            ? groups.map(aggregateLabel).join(', ')
            : t('trafficStats.filter.allGroups'),
          query.search,
        ]
          .filter(Boolean)
          .join(' | '),
        warningLabels: Object.fromEntries(
          [
            'storage_failed',
            'read_failed',
            'legacy_data',
            'legacy_aggregated',
            'sampling_gaps',
          ].map((code) => [
            code,
            t(`trafficStats.warnings.${code}` as TranslationKey),
          ]),
        ),
        summarySheet: t('trafficStats.export.summarySheet'),
        detailSheet: t('trafficStats.export.detailSheet'),
        time: t('trafficStats.export.time'),
        name: t(`trafficStats.dimensions.${dimension}` as TranslationKey),
        group: t('trafficStats.table.group'),
        process: t('trafficStats.table.process'),
        up: t('trafficStats.export.upBytes'),
        down: t('trafficStats.export.downBytes'),
        total: t('trafficStats.export.totalBytes'),
        share: `${t('trafficStats.export.share')} · ${t(`trafficStats.metrics.${metric}` as TranslationKey)}`,
        other: t('trafficStats.keys.other'),
        unattributed: t('trafficStats.keys.unattributed'),
        unknown: t('trafficStats.keys.unknown'),
      })
      showNotice.success('trafficStats.export.done')
    } catch (err) {
      showNotice.error(err)
    } finally {
      setExporting(false)
    }
  })
  const onClear = useLockFn(async () => {
    setClearing(true)
    try {
      await clearTrafficStats()
      await mutate(
        (key: unknown) => Array.isArray(key) && key[0] === 'getTrafficStats',
        undefined,
        { revalidate: false },
      )
      setConfirmClear(false)
      await refetch()
      showNotice.success('trafficStats.clear.done')
    } catch (err) {
      showNotice.error(err)
    } finally {
      setClearing(false)
    }
  })
  const hasData = totals.length > 0
  const diagnostics = [UNATTRIBUTED_KEY, UNKNOWN_KEY, OTHER_KEY]
    .map((key) => ({
      key,
      value: totals
        .filter((entry) => entry.key === key || entry.name === key)
        .reduce((sum, entry) => sum + metricValue(entry, metric), 0),
    }))
    .filter((entry) => entry.value > 0)
  return (
    <BasePage
      full
      title={t('trafficStats.page.title')}
      contentStyle={{ height: '100%', overflow: 'auto' }}
    >
      <Box
        sx={{
          p: 1.5,
          display: 'flex',
          flexDirection: 'column',
          gap: 1.5,
          userSelect: 'text',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 1,
          }}
        >
          <Typography sx={{ mr: 'auto', fontWeight: 600 }}>
            {t(`trafficStats.metrics.${metric}` as TranslationKey)}{' '}
            {formatBytes(grandTotal)}
          </Typography>
          <Button
            size="small"
            startIcon={<RefreshRounded />}
            onClick={handleRefresh}
            disabled={loading}
          >
            {t('shared.actions.refresh')}
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<FileDownloadOutlined />}
            disabled={
              !hasData ||
              loading ||
              exporting ||
              search.trim() !== debouncedSearch
            }
            onClick={onExport}
          >
            {t('trafficStats.actions.export')}
          </Button>
          <Button
            size="small"
            color="error"
            startIcon={<DeleteSweepRounded />}
            onClick={() => setConfirmClear(true)}
          >
            {t('shared.actions.clear')}
          </Button>
        </Box>
        <Typography variant="caption" color="text.secondary">
          {t('trafficStats.notes.scope')}{' '}
          {t('trafficStats.notes.manualRefresh')}
        </Typography>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 1,
          }}
        >
          <BaseStyledSelect
            value={rangeState.preset}
            inputProps={{ 'aria-label': t('trafficStats.filter.range') }}
            onChange={(e) => selectRange(e.target.value as RangePreset)}
          >
            {(['today', 'week', 'month', 'custom'] as const).map((value) => (
              <MenuItem key={value} value={value}>
                {t(`trafficStats.ranges.${value}` as TranslationKey)}
              </MenuItem>
            ))}
          </BaseStyledSelect>
          <BaseStyledSelect
            value={dimension}
            inputProps={{ 'aria-label': t('trafficStats.filter.dimension') }}
            onChange={(e) =>
              setDimension(e.target.value as TrafficStatsDimension)
            }
          >
            {(['host', 'process', 'group'] as const).map((value) => (
              <MenuItem key={value} value={value}>
                {t(`trafficStats.dimensions.${value}` as TranslationKey)}
              </MenuItem>
            ))}
          </BaseStyledSelect>
          <Select<string[]>
            multiple
            size="small"
            displayEmpty
            value={groups}
            sx={{ minWidth: 180, maxWidth: '100%' }}
            inputProps={{ 'aria-label': t('trafficStats.filter.group') }}
            renderValue={(selected) =>
              selected.length
                ? selected.map(aggregateLabel).join(', ')
                : t('trafficStats.filter.allGroups')
            }
            onChange={(e) =>
              setGroups(
                typeof e.target.value === 'string'
                  ? e.target.value.split(',')
                  : [...e.target.value].sort(),
              )
            }
          >
            {allGroups.map((group) => (
              <MenuItem key={group} value={group}>
                <Checkbox checked={groups.includes(group)} />
                <ListItemText primary={aggregateLabel(group)} />
              </MenuItem>
            ))}
          </Select>
          <Button
            size="small"
            onClick={() => setGroups(allGroups)}
            disabled={!allGroups.length}
          >
            {t('trafficStats.filter.selectAll')}
          </Button>
          <Button
            size="small"
            onClick={() => setGroups([])}
            disabled={!groups.length}
          >
            {t('trafficStats.filter.reset')}
          </Button>
          <BaseStyledSelect
            value={metric}
            inputProps={{ 'aria-label': t('trafficStats.filter.metric') }}
            onChange={(e) => setMetric(e.target.value as TrafficMetric)}
          >
            {(['total', 'up', 'down'] as const).map((value) => (
              <MenuItem key={value} value={value}>
                {t(`trafficStats.metrics.${value}` as TranslationKey)}
              </MenuItem>
            ))}
          </BaseStyledSelect>
          {dimension !== 'group' && (
            <BaseStyledSelect
              value={aggregate ? 'summary' : 'detail'}
              inputProps={{ 'aria-label': t('trafficStats.filter.view') }}
              onChange={(e) => setAggregate(e.target.value === 'summary')}
            >
              <MenuItem value="summary">
                {t('trafficStats.filter.summary')}
              </MenuItem>
              <MenuItem value="detail">
                {t('trafficStats.filter.detail')}
              </MenuItem>
            </BaseStyledSelect>
          )}
          <TextField
            size="small"
            label={t('trafficStats.filter.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            sx={{ minWidth: 200, flex: 1 }}
          />
        </Box>
        {rangeState.preset === 'custom' && (
          <Box
            sx={{
              display: 'flex',
              gap: 1,
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            <TextField
              type="date"
              size="small"
              label={t('trafficStats.filter.startDate')}
              slotProps={{ inputLabel: { shrink: true } }}
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
            />
            <TextField
              type="date"
              size="small"
              label={t('trafficStats.filter.endDate')}
              slotProps={{ inputLabel: { shrink: true } }}
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
            />
            <Button onClick={applyCustomRange} disabled={!customValid}>
              {t('trafficStats.filter.apply')}
            </Button>
            {!customValid && (
              <Typography color="error" variant="caption">
                {t('trafficStats.filter.invalidRange')}
              </Typography>
            )}
          </Box>
        )}
        <Typography variant="caption" color="text.secondary">
          {dayjs(query.startMs).format('YYYY-MM-DD')} —{' '}
          {dayjs(query.endMs).subtract(1, 'day').format('YYYY-MM-DD')} ·{' '}
          {t(
            aggregate && dimension !== 'group'
              ? 'trafficStats.notes.summary'
              : 'trafficStats.notes.detail',
          )}
        </Typography>
        {groups.length > 0 && (
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {groups.map((group) => (
              <Chip
                key={group}
                size="small"
                label={aggregateLabel(group)}
                onDelete={() =>
                  setGroups((current) =>
                    current.filter((value) => value !== group),
                  )
                }
              />
            ))}
          </Box>
        )}
        {loading && (
          <LinearProgress aria-label={t('trafficStats.notes.loading')} />
        )}
        {error && (
          <Alert
            severity="error"
            action={
              <Button onClick={() => void refetch()}>
                {t('shared.actions.refresh')}
              </Button>
            }
          >
            {t('trafficStats.notes.loadError')} {String(error)}
          </Alert>
        )}
        {verge?.enable_traffic_stats === false && (
          <Alert severity="warning">{t('trafficStats.notes.disabled')}</Alert>
        )}
        {((dimension === 'host' &&
          verge?.traffic_stats_record_host === false) ||
          (dimension === 'process' &&
            verge?.traffic_stats_record_process === false)) && (
          <Alert severity="info">
            {t('trafficStats.notes.dimensionDisabled')}
          </Alert>
        )}
        {Boolean(stats?.warnings?.length) && (
          <Alert severity="warning">
            {t('trafficStats.notes.incomplete')}{' '}
            {stats?.warnings
              ?.map((warning) =>
                t(`trafficStats.warnings.${warning}` as TranslationKey, {
                  defaultValue: t('trafficStats.notes.incomplete'),
                }),
              )
              .join(' ')}
          </Alert>
        )}
        <Alert severity="info">{t('trafficStats.notes.categories')}</Alert>
        {diagnostics.length > 0 && (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {diagnostics.map((entry) => (
              <Chip
                key={entry.key}
                variant="outlined"
                label={`${aggregateLabel(entry.key)}: ${formatBytes(entry.value)} (${grandTotal ? ((entry.value / grandTotal) * 100).toFixed(1) : '0'}%)`}
              />
            ))}
          </Box>
        )}
        {!hasData && !loading && !error && (
          <BaseEmpty
            text={t(
              groups.length || search
                ? 'trafficStats.noMatches'
                : 'trafficStats.empty',
            )}
          />
        )}
        {(hasData || buckets.some((bucket) => bucket.observed)) && (
          <>
            <Paper elevation={0} sx={{ p: 1, borderRadius: 1.5 }}>
              <StackedBarChart
                buckets={chartBuckets}
                orderedKeys={chartKeys}
                colorOf={colorOf}
                labelOf={chartLabelOf}
                granularity={stats?.granularity ?? rangeState.granularity}
                metric={metric}
              />
            </Paper>
            <Paper elevation={0} sx={{ borderRadius: 1.5, minWidth: 0 }}>
              <StatsTable
                entries={tableEntries}
                displayName={displayName}
                displayGroup={displayGroup}
                displayProcess={displayProcess}
                colorOf={colorOf}
                metric={metric}
                showProcessColumn={dimension === 'host' && !aggregate}
                showGroupColumn={dimension !== 'group' && !aggregate}
              />
            </Paper>
          </>
        )}
        {stats?.truncated && (
          <Alert
            severity="info"
            action={
              <Button onClick={() => setShowAll(true)}>
                {t('trafficStats.actions.showAll')}
              </Button>
            }
          >
            {t('trafficStats.notes.topN')}
          </Alert>
        )}
        <Typography variant="caption" color="text.secondary">
          {t('trafficStats.notes.accuracy')}
        </Typography>
      </Box>
      <BaseDialog
        open={confirmClear}
        title={t('trafficStats.clear.title')}
        contentSx={{ width: 'min(400px, 75vw)' }}
        okBtn={t('trafficStats.clear.confirm')}
        cancelBtn={t('shared.actions.cancel')}
        loading={clearing}
        disableCancel={clearing}
        onClose={() => !clearing && setConfirmClear(false)}
        onCancel={() => setConfirmClear(false)}
        onOk={onClear}
      >
        <Typography>{t('trafficStats.clear.message')}</Typography>
      </BaseDialog>
    </BasePage>
  )
}
export default TrafficStatsPage
