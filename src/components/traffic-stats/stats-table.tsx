import { ArrowDownwardRounded, ArrowUpwardRounded } from '@mui/icons-material'
import { Box, Typography, useTheme } from '@mui/material'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { TranslationKey } from '@/types/generated/i18n-keys'
import parseTraffic from '@/utils/parse-traffic'

import { metricValue, type TrafficMetric } from './shared'

type SortField = 'name' | 'group' | 'process' | 'up' | 'down' | 'total'

interface Props {
  entries: ITrafficStatsEntry[]
  /** 聚合项要换成人话，其余用原名 */
  displayName: (entry: ITrafficStatsEntry) => string
  displayGroup: (entry: ITrafficStatsEntry) => string
  displayProcess?: (entry: ITrafficStatsEntry) => string
  colorOf: (key: string) => string
  metric: TrafficMetric
  showProcessColumn?: boolean
}

const formatBytes = (value: number) => parseTraffic(value).join(' ')

export const StatsTable = ({
  entries,
  displayName,
  displayGroup,
  displayProcess,
  colorOf,
  metric,
  showProcessColumn,
}: Props) => {
  const gridColumns = showProcessColumn
    ? '36px minmax(140px, 1.6fr) minmax(90px, 0.9fr) minmax(90px, 0.9fr) 100px 100px 100px 60px'
    : '36px minmax(140px, 1.6fr) minmax(90px, 0.9fr) 100px 100px 100px 60px'
  const { t } = useTranslation()
  const theme = useTheme()
  const [sort, setSort] = useState<{ field: SortField; desc: boolean }>({
    field: 'total',
    desc: true,
  })

  const sorted = useMemo(() => {
    const compareText = (left: string, right: string) =>
      left.localeCompare(right)
    const compare = (left: ITrafficStatsEntry, right: ITrafficStatsEntry) => {
      if (sort.field === 'name') {
        return compareText(displayName(left), displayName(right))
      }
      if (sort.field === 'group') {
        return compareText(displayGroup(left), displayGroup(right))
      }
      if (sort.field === 'process') {
        return compareText(
          displayProcess?.(left) ?? '',
          displayProcess?.(right) ?? '',
        )
      }
      if (sort.field === 'up') return left.up - right.up
      if (sort.field === 'down') return left.down - right.down
      return left.up + left.down - (right.up + right.down)
    }

    const next = [...entries]
    next.sort((left, right) => {
      const compared = compare(left, right)
      return sort.desc ? -compared : compared
    })
    return next
  }, [entries, displayName, displayGroup, displayProcess, sort])

  // 占比条以「当前展示口径下的最大值」为满格，视觉对比更明显
  const peak = useMemo(
    () =>
      sorted.reduce(
        (max, entry) => Math.max(max, metricValue(entry, metric)),
        0,
      ),
    [sorted, metric],
  )
  const grandTotal = useMemo(
    () => sorted.reduce((sum, entry) => sum + metricValue(entry, metric), 0),
    [sorted, metric],
  )

  const toggleSort = (field: SortField) => {
    setSort((current) =>
      current.field === field
        ? { field, desc: !current.desc }
        : { field, desc: field !== 'name' && field !== 'group' && field !== 'process' },
    )
  }

  const renderHeader = (
    field: SortField,
    labelKey: TranslationKey,
    align: 'left' | 'right',
  ) => (
    <Box
      onClick={() => toggleSort(field)}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        gap: 0.3,
        cursor: 'pointer',
        userSelect: 'none',
        color: sort.field === field ? 'text.primary' : 'text.secondary',
      }}
    >
      <Typography variant="caption" sx={{ fontWeight: 600 }}>
        {t(labelKey)}
      </Typography>
      {sort.field === field &&
        (sort.desc ? (
          <ArrowDownwardRounded sx={{ fontSize: 13 }} />
        ) : (
          <ArrowUpwardRounded sx={{ fontSize: 13 }} />
        ))}
    </Box>
  )

  return (
    <Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: gridColumns,
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.6,
          position: 'sticky',
          top: 0,
          zIndex: 1,
          bgcolor: 'background.paper',
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Typography variant="caption" color="text.secondary">
          #
        </Typography>
        {renderHeader('name', 'trafficStats.table.name', 'left')}
        {renderHeader('group', 'trafficStats.table.group', 'left')}
        {showProcessColumn &&
          renderHeader('process', 'trafficStats.table.process', 'left')}
        {renderHeader('up', 'trafficStats.table.up', 'right')}
        {renderHeader('down', 'trafficStats.table.down', 'right')}
        {renderHeader('total', 'trafficStats.table.total', 'right')}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ textAlign: 'right' }}
        >
          {t('trafficStats.table.share')}
        </Typography>
      </Box>

      {sorted.map((entry, index) => {
        const value = metricValue(entry, metric)
        const share = grandTotal > 0 ? (value / grandTotal) * 100 : 0
        const barWidth = peak > 0 ? (value / peak) * 100 : 0
        const name = displayName(entry)
        const group = displayGroup(entry)

        return (
          <Box
            key={entry.key}
            sx={{
              display: 'grid',
              gridTemplateColumns: gridColumns,
              alignItems: 'center',
              gap: 1,
              px: 1,
              py: 0.7,
              position: 'relative',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            {/* 占比条铺在行底，不额外占列宽 */}
            <Box
              sx={{
                position: 'absolute',
                left: 0,
                top: 2,
                bottom: 2,
                width: `${barWidth}%`,
                bgcolor: colorOf(entry.key),
                opacity: 0.14,
                borderRadius: '0 4px 4px 0',
                pointerEvents: 'none',
              }}
            />
            <Typography variant="caption" color="text.secondary">
              {index + 1}
            </Typography>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.8,
                minWidth: 0,
              }}
            >
              <Box
                sx={{
                  width: 9,
                  height: 9,
                  borderRadius: '2px',
                  flexShrink: 0,
                  bgcolor: colorOf(entry.key),
                }}
              />
              <Typography variant="body2" noWrap title={name}>
                {name}
              </Typography>
            </Box>
            <Typography
              variant="body2"
              color="text.secondary"
              noWrap
              title={group}
            >
              {group}
            </Typography>
            {showProcessColumn && (
              <Typography
                variant="body2"
                color="text.secondary"
                noWrap
                title={displayProcess?.(entry) ?? ''}
              >
                {displayProcess?.(entry) ?? ''}
              </Typography>
            )}
            <Typography
              variant="body2"
              sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
            >
              {formatBytes(entry.up)}
            </Typography>
            <Typography
              variant="body2"
              sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
            >
              {formatBytes(entry.down)}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                textAlign: 'right',
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatBytes(entry.up + entry.down)}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
            >
              {share.toFixed(1)}%
            </Typography>
          </Box>
        )
      })}
    </Box>
  )
}
