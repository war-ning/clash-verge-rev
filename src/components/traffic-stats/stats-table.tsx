import { ArrowDownwardRounded, ContentCopyRounded } from '@mui/icons-material'
import {
  Box,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Typography,
} from '@mui/material'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { showNotice } from '@/services/notice-service'
import type { TranslationKey } from '@/types/generated/i18n-keys'
import parseTraffic from '@/utils/parse-traffic'

import { metricValue, type TrafficMetric } from './shared'

type SortField = 'name' | 'group' | 'process' | 'up' | 'down' | 'total'

interface Props {
  entries: ITrafficStatsEntry[]
  displayName: (entry: ITrafficStatsEntry) => string
  displayGroup: (entry: ITrafficStatsEntry) => string
  displayProcess?: (entry: ITrafficStatsEntry) => string
  colorOf: (key: string) => string
  metric: TrafficMetric
  showProcessColumn?: boolean
  showGroupColumn?: boolean
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
  showGroupColumn = true,
}: Props) => {
  const { t } = useTranslation()
  // An explicit sort survives metric changes; otherwise ranking follows the selected metric.
  const [manualSort, setManualSort] = useState<{
    field: SortField
    desc: boolean
  } | null>(null)
  const sort = manualSort ?? { field: metric, desc: true }
  const sorted = useMemo(() => {
    const textOf = (entry: ITrafficStatsEntry) => {
      if (sort.field === 'name') return displayName(entry)
      if (sort.field === 'group') return displayGroup(entry)
      return displayProcess?.(entry) ?? ''
    }
    return [...entries].sort((left, right) => {
      const compared =
        sort.field === 'name' ||
        sort.field === 'group' ||
        sort.field === 'process'
          ? textOf(left).localeCompare(textOf(right))
          : metricValue(left, sort.field) - metricValue(right, sort.field)
      return sort.desc ? -compared : compared
    })
  }, [
    entries,
    displayName,
    displayGroup,
    displayProcess,
    sort.field,
    sort.desc,
  ])
  const grandTotal = useMemo(
    () => entries.reduce((sum, entry) => sum + metricValue(entry, metric), 0),
    [entries, metric],
  )
  const copy = async (value: string) => {
    try {
      await writeText(value)
    } catch (err) {
      showNotice.error(err)
    }
  }
  const header = (field: SortField, key: TranslationKey, numeric = false) => (
    <TableCell
      align={numeric ? 'right' : 'left'}
      sortDirection={
        sort.field === field ? (sort.desc ? 'desc' : 'asc') : false
      }
    >
      <TableSortLabel
        active={sort.field === field}
        direction={sort.field === field && !sort.desc ? 'asc' : 'desc'}
        IconComponent={ArrowDownwardRounded}
        onClick={() =>
          setManualSort({
            field,
            desc:
              sort.field === field
                ? !sort.desc
                : !['name', 'group', 'process'].includes(field),
          })
        }
      >
        {t(key)}
      </TableSortLabel>
    </TableCell>
  )

  return (
    <TableContainer sx={{ overflowX: 'auto', userSelect: 'text' }}>
      <Table
        size="small"
        aria-label={t('trafficStats.page.title')}
        sx={{
          minWidth: showProcessColumn ? 780 : 620,
          tableLayout: 'auto',
          '& th': { whiteSpace: 'nowrap' },
          '& td': { verticalAlign: 'top' },
        }}
      >
        <TableHead>
          <TableRow>
            <TableCell>#</TableCell>
            {header('name', 'trafficStats.table.name')}
            {showGroupColumn && header('group', 'trafficStats.table.group')}
            {showProcessColumn &&
              header('process', 'trafficStats.table.process')}
            {header('up', 'trafficStats.table.up', true)}
            {header('down', 'trafficStats.table.down', true)}
            {header('total', 'trafficStats.table.total', true)}
            <TableCell align="right">{t('trafficStats.table.share')}</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {sorted.map((entry, index) => {
            const share =
              grandTotal > 0
                ? (metricValue(entry, metric) / grandTotal) * 100
                : 0
            const name = displayName(entry)
            const process = displayProcess?.(entry)
            return (
              <TableRow
                key={entry.key}
                hover
                sx={{
                  backgroundImage: `linear-gradient(90deg, ${colorOf(entry.key)} 0%, ${colorOf(entry.key)} ${share}%, transparent ${share}%)`,
                  backgroundSize: '100% 3px',
                  backgroundPosition: 'left bottom',
                  backgroundRepeat: 'no-repeat',
                }}
              >
                <TableCell sx={{ color: 'text.secondary' }}>
                  {index + 1}
                </TableCell>
                <TableCell sx={{ minWidth: 170, maxWidth: 340 }}>
                  <Box
                    sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}
                  >
                    <Box
                      sx={{
                        width: 9,
                        height: 9,
                        mt: 0.7,
                        flexShrink: 0,
                        bgcolor: colorOf(entry.key),
                        borderRadius: '2px',
                      }}
                    />
                    <Typography
                      variant="body2"
                      sx={{ overflowWrap: 'anywhere', flex: 1 }}
                    >
                      {name}
                    </Typography>
                    <IconButton
                      size="small"
                      aria-label={t('trafficStats.table.copyName')}
                      title={t('trafficStats.table.copyName')}
                      onClick={() => void copy(name)}
                    >
                      <ContentCopyRounded sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Box>
                  {!showProcessColumn && entry.processPath && (
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 0.5,
                        mt: 0.4,
                      }}
                    >
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ overflowWrap: 'anywhere', flex: 1 }}
                      >
                        {entry.processPath}
                      </Typography>
                      <IconButton
                        size="small"
                        aria-label={t('trafficStats.table.copyProcessPath')}
                        title={t('trafficStats.table.copyProcessPath')}
                        onClick={() => void copy(entry.processPath!)}
                      >
                        <ContentCopyRounded sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Box>
                  )}
                </TableCell>
                {showGroupColumn && (
                  <TableCell
                    sx={{
                      minWidth: 90,
                      maxWidth: 200,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {displayGroup(entry)}
                  </TableCell>
                )}
                {showProcessColumn && (
                  <TableCell
                    sx={{
                      minWidth: 130,
                      maxWidth: 300,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    <Typography variant="body2" color="text.secondary">
                      {process || t('trafficStats.table.processUnavailable')}
                    </Typography>
                    {entry.processPath && (
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 0.5,
                        }}
                      >
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ overflowWrap: 'anywhere', flex: 1 }}
                        >
                          {entry.processPath}
                        </Typography>
                        <IconButton
                          size="small"
                          aria-label={t('trafficStats.table.copyProcessPath')}
                          title={t('trafficStats.table.copyProcessPath')}
                          onClick={() => void copy(entry.processPath!)}
                        >
                          <ContentCopyRounded sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Box>
                    )}
                  </TableCell>
                )}
                <TableCell
                  align="right"
                  sx={{
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatBytes(entry.up)}
                </TableCell>
                <TableCell
                  align="right"
                  sx={{
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatBytes(entry.down)}
                </TableCell>
                <TableCell
                  align="right"
                  sx={{
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                    fontWeight: 600,
                  }}
                >
                  {formatBytes(entry.up + entry.down)}
                </TableCell>
                <TableCell
                  align="right"
                  sx={{
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {share.toFixed(1)}%
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </TableContainer>
  )
}
