import {
  DeleteSweepRounded,
  FileDownloadOutlined,
  RefreshRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Paper,
  Typography,
  useTheme,
} from '@mui/material'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

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

type RangePreset = 'today' | 'week' | 'month'

/** 图表最多堆叠的序列数，其余合并成「其他」，否则颜色无法区分。 */
const CHART_SERIES = 8
/** 向后端请求的 Top-N，同时也是表格最多展示的条目数。 */
const TABLE_TOP_N = 50

const RANGE_OPTIONS: { value: RangePreset; labelKey: TranslationKey }[] = [
  { value: 'today', labelKey: 'trafficStats.ranges.today' },
  { value: 'week', labelKey: 'trafficStats.ranges.week' },
  { value: 'month', labelKey: 'trafficStats.ranges.month' },
]

const DIMENSION_OPTIONS: {
  value: TrafficStatsDimension
  labelKey: TranslationKey
}[] = [
  { value: 'host', labelKey: 'trafficStats.dimensions.host' },
  { value: 'process', labelKey: 'trafficStats.dimensions.process' },
  { value: 'group', labelKey: 'trafficStats.dimensions.group' },
]

const METRIC_OPTIONS: { value: TrafficMetric; labelKey: TranslationKey }[] = [
  { value: 'total', labelKey: 'trafficStats.metrics.total' },
  { value: 'down', labelKey: 'trafficStats.metrics.down' },
  { value: 'up', labelKey: 'trafficStats.metrics.up' },
]

/** 时间边界按本地时区对齐，与后端的小时桶口径一致。 */
const resolveRange = (preset: RangePreset) => {
  const endMs = dayjs().add(1, 'day').startOf('day').valueOf()
  if (preset === 'today') {
    return {
      startMs: dayjs().startOf('day').valueOf(),
      endMs,
      granularity: 'hour' as TrafficStatsGranularity,
    }
  }
  const days = preset === 'week' ? 6 : 29
  return {
    startMs: dayjs().subtract(days, 'day').startOf('day').valueOf(),
    endMs,
    granularity: 'day' as TrafficStatsGranularity,
  }
}

const TrafficStatsPage = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const { verge } = useVerge()

  // 时间边界随选择一并落到 state，刷新时重算，避免跨零点后边界一直停在昨天
  const [rangeState, setRangeState] = useState(() => ({
    preset: 'today' as RangePreset,
    ...resolveRange('today'),
  }))
  const [dimension, setDimension] = useState<TrafficStatsDimension>('host')
  const [metric, setMetric] = useState<TrafficMetric>('total')
  const [groupFilter, setGroupFilter] = useState<string>('')
  const [confirmClear, setConfirmClear] = useState(false)

  const query = useMemo<ITrafficStatsQuery>(
    () => ({
      dimension,
      startMs: rangeState.startMs,
      endMs: rangeState.endMs,
      granularity: rangeState.granularity,
      topN: TABLE_TOP_N,
    }),
    [dimension, rangeState],
  )

  const { stats, loading, refetch } = useTrafficStats(query)

  const totals = useMemo(() => stats?.totals ?? [], [stats])
  const buckets = useMemo(() => stats?.buckets ?? [], [stats])

  const allGroups = useMemo(() => {
    const groups = new Set<string>()
    totals.forEach((e) => {
      if (e.group) groups.add(e.group)
    })
    return [...groups].sort()
  }, [totals])

  const filteredTotals = useMemo(() => {
    if (!groupFilter) return totals
    return totals.filter((e) => e.group === groupFilter)
  }, [totals, groupFilter])

  const filteredBuckets = useMemo(() => {
    if (!groupFilter) return buckets
    return buckets.map((b) => ({
      ...b,
      items: b.items.filter((e) => e.group === groupFilter),
    }))
  }, [buckets, groupFilter])

  const isDark = theme.palette.mode === 'dark'

  // 颜色按 totals 排名固定，切换口径时同一条记录颜色不跳
  const colorMap = useMemo(() => {
    const map = new Map<string, string>()
    let colorIndex = 0
    filteredTotals.forEach((entry) => {
      if (isAggregateKey(entry.key)) {
        map.set(entry.key, colorForAggregate(entry.key, isDark))
        return
      }
      map.set(entry.key, colorForIndex(colorIndex, isDark))
      colorIndex += 1
    })
    return map
  }, [filteredTotals, isDark])

  const colorOf = useCallback(
    (key: string) => colorMap.get(key) ?? colorForAggregate(key, isDark),
    [colorMap, isDark],
  )

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
    (entry: ITrafficStatsEntry) => aggregateLabel(entry.name),
    [aggregateLabel],
  )

  const displayGroup = useCallback(
    (entry: ITrafficStatsEntry) => {
      if (dimension === 'group') return ''
      return entry.group ? aggregateLabel(entry.group) : ''
    },
    [aggregateLabel, dimension],
  )

  const displayProcess = useCallback(
    (entry: ITrafficStatsEntry) =>
      entry.process ? aggregateLabel(entry.process) : '',
    [aggregateLabel],
  )

  // 图表按复合键索引，tooltip 里把名称和策略组一起显示出来
  const entryByKey = useMemo(() => {
    const map = new Map<string, ITrafficStatsEntry>()
    filteredTotals.forEach((entry) => map.set(entry.key, entry))
    return map
  }, [filteredTotals])

  const chartLabelOf = useCallback(
    (key: string) => {
      const entry = entryByKey.get(key)
      if (!entry) return aggregateLabel(key)
      if (dimension === 'group') return displayName(entry)
      const group = displayGroup(entry)
      const name = displayName(entry)
      return group ? `${name} · ${group}` : name
    },
    [entryByKey, aggregateLabel, displayGroup, displayName, dimension],
  )

  // 图表只画前 N 个序列，其余在每个桶里就地合并成「其他」
  const { chartKeys, chartBuckets } = useMemo(() => {
    const topKeys = filteredTotals
      .slice(0, CHART_SERIES)
      .map((entry) => entry.key)
    const topSet = new Set(topKeys)
    let hasOverflow = false

    const mapped: ITrafficStatsBucket[] = filteredBuckets.map((bucket) => {
      const merged = new Map<string, ITrafficStatsEntry>()
      bucket.items.forEach((item) => {
        const key = topSet.has(item.key) ? item.key : OTHER_KEY
        if (key === OTHER_KEY && !topSet.has(OTHER_KEY)) hasOverflow = true
        const current = merged.get(key)
        if (current) {
          current.up += item.up
          current.down += item.down
        } else {
          merged.set(key, {
            key,
            name: key === OTHER_KEY ? OTHER_KEY : item.name,
            group: key === OTHER_KEY ? null : item.group,
            up: item.up,
            down: item.down,
          })
        }
      })
      return { ts: bucket.ts, items: [...merged.values()] }
    })

    const keys = hasOverflow ? [...topKeys, OTHER_KEY] : topKeys
    return { chartKeys: keys, chartBuckets: mapped }
  }, [filteredBuckets, filteredTotals])

  const grandTotal = useMemo(
    () =>
      filteredTotals.reduce((sum, entry) => sum + entry.up + entry.down, 0),
    [filteredTotals],
  )

  const handleSelectRange = (preset: RangePreset) => {
    setRangeState({ preset, ...resolveRange(preset) })
  }

  const handleRefresh = () => {
    setRangeState((current) => ({
      preset: current.preset,
      ...resolveRange(current.preset),
    }))
    void refetch()
  }

  const onExport = useLockFn(async () => {
    const defaultName = `traffic-stats-${dimension}-${dayjs().format('YYYYMMDD-HHmm')}.xlsx`
    const path = await saveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    })
    if (!path) return

    try {
      // 表头文案跟随界面语言，后端不掺和 i18n
      await exportTrafficStats(query, path, {
        summarySheet: t('trafficStats.export.summarySheet'),
        detailSheet: t('trafficStats.export.detailSheet'),
        time: t('trafficStats.export.time'),
        name: t(`trafficStats.dimensions.${dimension}` as TranslationKey),
        group: t('trafficStats.table.group'),
        process: t('trafficStats.table.process'),
        up: t('trafficStats.export.upBytes'),
        down: t('trafficStats.export.downBytes'),
        total: t('trafficStats.export.totalBytes'),
        share: t('trafficStats.export.share'),
        other: t('trafficStats.keys.other'),
        unattributed: t('trafficStats.keys.unattributed'),
        unknown: t('trafficStats.keys.unknown'),
      })
      showNotice.success('trafficStats.export.done')
    } catch (err) {
      showNotice.error(err)
    }
  })

  const onClear = useLockFn(async () => {
    try {
      await clearTrafficStats()
      setConfirmClear(false)
      await refetch()
      showNotice.success('trafficStats.clear.done')
    } catch (err) {
      showNotice.error(err)
    }
  })

  const statsDisabled = verge?.enable_traffic_stats === false
  const hasData = filteredTotals.length > 0

  return (
    <BasePage
      full
      title={t('trafficStats.page.title')}
      contentStyle={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
      }}
      header={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {t('trafficStats.page.grandTotal', {
              value: parseTraffic(grandTotal).join(' '),
            })}
          </Typography>
          <IconButton
            size="small"
            color="inherit"
            title={t('shared.actions.refresh')}
            aria-label={t('shared.actions.refresh')}
            onClick={handleRefresh}
          >
            <RefreshRounded />
          </IconButton>
          <Button
            size="small"
            variant="outlined"
            startIcon={<FileDownloadOutlined />}
            disabled={!hasData}
            onClick={onExport}
          >
            {t('trafficStats.actions.export')}
          </Button>
          <Button
            size="small"
            variant="outlined"
            color="error"
            startIcon={<DeleteSweepRounded />}
            onClick={() => setConfirmClear(true)}
          >
            {t('shared.actions.clear')}
          </Button>
        </Box>
      }
    >
      <Box
        sx={{
          pt: 1,
          mb: 0.5,
          mx: '10px',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 0.5,
        }}
      >
        <BaseStyledSelect
          value={rangeState.preset}
          onChange={(e) => handleSelectRange(e.target.value as RangePreset)}
        >
          {RANGE_OPTIONS.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </MenuItem>
          ))}
        </BaseStyledSelect>

        <BaseStyledSelect
          value={dimension}
          onChange={(e) => {
            setDimension(e.target.value as TrafficStatsDimension)
            setGroupFilter('')
          }}
        >
          {DIMENSION_OPTIONS.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </MenuItem>
          ))}
        </BaseStyledSelect>

        {allGroups.length > 0 && (
          <BaseStyledSelect
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value as string)}
          >
            <MenuItem value="">{t('trafficStats.filter.all')}</MenuItem>
            {allGroups.map((g) => (
              <MenuItem key={g} value={g}>
                {g}
              </MenuItem>
            ))}
          </BaseStyledSelect>
        )}

        <BaseStyledSelect
          value={metric}
          onChange={(e) => setMetric(e.target.value as TrafficMetric)}
        >
          {METRIC_OPTIONS.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </MenuItem>
          ))}
        </BaseStyledSelect>
      </Box>

      {statsDisabled && (
        <Typography
          variant="caption"
          color="warning.main"
          sx={{ mx: '10px', mb: 0.5 }}
        >
          {t('trafficStats.notes.disabled')}
        </Typography>
      )}

      {!hasData && !loading ? (
        <BaseEmpty text={t('trafficStats.empty')} />
      ) : (
        <Box
          sx={{
            mx: '10px',
            mb: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
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

          <Paper elevation={0} sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
            <StatsTable
              entries={filteredTotals}
              displayName={displayName}
              displayGroup={displayGroup}
              displayProcess={displayProcess}
              colorOf={colorOf}
              metric={metric}
              showProcessColumn={dimension === 'host'}
            />
          </Paper>

          <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
            {t('trafficStats.notes.accuracy')}
          </Typography>
        </Box>
      )}

      <BaseDialog
        open={confirmClear}
        title={t('trafficStats.clear.title')}
        contentSx={{ width: 400 }}
        okBtn={t('trafficStats.clear.confirm')}
        cancelBtn={t('shared.actions.cancel')}
        onClose={() => setConfirmClear(false)}
        onCancel={() => setConfirmClear(false)}
        onOk={onClear}
      >
        <Typography variant="body2">
          {t('trafficStats.clear.message')}
        </Typography>
      </BaseDialog>
    </BasePage>
  )
}

export default TrafficStatsPage
