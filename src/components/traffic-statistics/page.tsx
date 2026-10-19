import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import en from '@/locales/en/trafficStatistics.json'
import type { StatisticsApi } from '@/services/traffic-statistics/api'
import type {
  Dimension,
  Metric,
  Query,
  Ranking,
  StatisticsSettings,
  StatisticsSnapshot,
} from '@/services/traffic-statistics/model'
import {
  amount,
  analyze,
  exportAnalysis,
  rank,
} from '@/services/traffic-statistics/query'

import {
  calendarDate,
  dateInput,
  dateRange,
  initialQuery,
  presetRange,
} from './dates'

const dimensions: Dimension[] = ['target', 'process', 'group']
const metrics: Metric[] = ['total', 'download', 'upload']
const bytes = (value: number) => {
  if (!value) return '0 B'
  const index = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: index ? 2 : 0 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][index]}`
}
const colors = ['#5577dd', '#2d9c95', '#bd873c', '#a76ab1', '#cc737d']
const color = (key: string) =>
  colors[
    Array.from(key).reduce(
      (hash, character) => hash + character.charCodeAt(0),
      0,
    ) % colors.length
  ]
const formatTime = (time: number, timezone: string) =>
  new Date(time).toLocaleString(undefined, {
    timeZone: timezone,
    timeZoneName: 'short',
  })
type TimeBucket = ReturnType<typeof analyze>['buckets'][number]
function displayBuckets(buckets: TimeBucket[], timezone: string): TimeBucket[] {
  if (buckets.length <= 48) return buckets
  const days = new Map<string, TimeBucket>()
  for (const bucket of buckets) {
    const key = calendarDate(bucket.start, timezone)
    const previous = days.get(key)
    if (previous) {
      previous.end = bucket.end
      previous.upload += bucket.upload
      previous.download += bucket.download
      previous.covered += bucket.covered
      previous.records.push(...bucket.records)
    } else days.set(key, { ...bucket, records: [...bucket.records] })
  }
  return [...days.values()]
}
const errorDetail = (error: unknown) =>
  error && typeof error === 'object' && 'detail' in error
    ? String(error.detail)
    : String(error)

export function StatisticsPage({
  api,
  preview = false,
}: {
  api: StatisticsApi
  preview?: boolean
}) {
  const { t } = useTranslation()
  const text = Object.fromEntries(
    (Object.keys(en) as (keyof typeof en)[]).map((key) => [
      key,
      t(`trafficStatistics.${key}`),
    ]),
  ) as typeof en
  const [query, setQuery] = useState(initialQuery)
  const showTime = (time: number) => formatTime(time, query.timezone)
  const [preset, setPreset] = useState(1)
  const [draftStart, setDraftStart] = useState(() => dateInput(new Date()))
  const [draftEnd, setDraftEnd] = useState(() => dateInput(new Date()))
  const [snapshot, setSnapshot] = useState<StatisticsSnapshot>()
  const [loadedAt, setLoadedAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [all, setAll] = useState(false)
  const [rankingPage, setRankingPage] = useState(0)
  const [combinationsOpen, setCombinationsOpen] = useState(false)
  const [details, setDetails] = useState<{
    title: string
    focus?: Query['focus']
    interval?: Query['interval']
  }>()
  const [manage, setManage] = useState(false)
  const [settings, setSettings] = useState<StatisticsSettings>()
  const [confirmation, setConfirmation] = useState<'clear' | 'export'>()
  const requestRef = useRef(0)
  const pendingRef = useRef(false)
  const aliveRef = useRef(true)
  const refresh = useCallback(
    async (
      range: Pick<Query, 'start' | 'end'> & Partial<Pick<Query, 'timezone'>>,
    ) => {
      const id = ++requestRef.current
      setBusy(true)
      setError('')
      try {
        const next = await api.read(range.start, range.end)
        if (!aliveRef.current || id !== requestRef.current) return
        setSnapshot(next)
        setLoadedAt(Date.now())
        setQuery((previous) => ({
          ...previous,
          ...range,
          timezone:
            range.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        }))
      } catch (failure) {
        if (aliveRef.current && id === requestRef.current)
          setError(errorDetail(failure))
      } finally {
        if (aliveRef.current && id === requestRef.current) setBusy(false)
      }
    },
    [api],
  )
  useEffect(() => {
    aliveRef.current = true
    void refresh(presetRange(1))
    return () => {
      aliveRef.current = false
      requestRef.current += 1
    }
  }, [refresh])
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (preset && !pendingRef.current) {
        const next = presetRange(preset)
        if (
          next.start !== query.start ||
          Intl.DateTimeFormat().resolvedOptions().timeZone !== query.timezone
        )
          void refresh(next)
      }
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [preset, query.start, query.timezone, refresh])
  const result = useMemo(
    () => (snapshot ? analyze(snapshot, query) : undefined),
    [snapshot, query],
  )
  const detailQuery = details
    ? { ...query, focus: details.focus, interval: details.interval }
    : query
  const detailResult =
    snapshot && details ? analyze(snapshot, detailQuery) : undefined
  const activeQuery = details ? detailQuery : query
  const groups = [
    ...new Set([...(snapshot?.groups ?? []), ...(query.groups ?? [])]),
  ].sort()
  const settingsValid =
    settings &&
    Number.isInteger(settings.retentionDays) &&
    settings.retentionDays >= 1 &&
    settings.retentionDays <= 366

  const action = async (operation: () => Promise<void>, success?: string) => {
    if (pendingRef.current) return
    pendingRef.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await operation()
      if (success) setNotice(success)
    } catch (failure) {
      setError(errorDetail(failure))
    } finally {
      pendingRef.current = false
      setBusy(false)
    }
  }
  const doExport = async () => {
    if (!snapshot?.durable) return
    const data = exportAnalysis(snapshot, activeQuery)
    setConfirmation(undefined)
    await action(async () => {
      if (await api.export(data)) setNotice(text.exported)
    })
  }
  const openObject = (row: Ranking) =>
    setDetails({
      title: row.identity.unattributed
        ? text.unattributed
        : (row.label ?? `${text.unknown} · ${text[query.dimension]}`),
      focus: { dimension: query.dimension, key: row.key },
    })
  const label = (row: Ranking, dimension: Dimension) =>
    row.identity.unattributed
      ? text.unattributed
      : (row.label ?? `${text.unknown} · ${text[dimension]}`)
  const copy = (value: string) =>
    action(async () => {
      await api.copy(value)
    }, text.copied)
  const shown = result?.ranking.filter((row) => !row.special) ?? []
  const specials = result?.ranking.filter((row) => row.special) ?? []
  const rankingOffset = Math.min(
    rankingPage,
    Math.max(0, Math.ceil(shown.length / 50) - 1),
  )
  const displayed = [
    ...(all
      ? shown.slice(rankingOffset * 50, (rankingOffset + 1) * 50)
      : shown.slice(0, 50)),
    ...specials,
  ]
  const denominator = result ? amount(result.totals, query.metric) : 0
  const expectedCoverage = Math.max(
    0,
    Math.min(query.end, loadedAt) - query.start,
  )
  const knownBytes =
    result?.ranking
      .filter((row) => !row.special)
      .reduce((sum, row) => sum + amount(row, query.metric), 0) ?? 0
  const leaders = result
    ? rank(result.records, { ...query, order: 'default' }).slice(0, 4)
    : []
  const [highlight, setHighlight] = useState<string>()
  const buckets = useMemo(
    () => displayBuckets(result?.buckets ?? [], query.timezone),
    [result, query.timezone],
  )
  const detailBuckets = displayBuckets(
    detailResult?.buckets ?? [],
    query.timezone,
  )
  const detailPeak = Math.max(
    1,
    ...detailBuckets.map((bucket) => amount(bucket, query.metric)),
  )
  const peak = Math.max(
    1,
    ...buckets.map((bucket) => amount(bucket, query.metric)),
  )

  return (
    <Stack
      spacing={2}
      sx={{ p: { xs: 1.5, sm: 3 }, minWidth: 0, userSelect: 'text' }}
    >
      {preview && <Alert severity="info">{text.development}</Alert>}
      <Stack
        direction="row"
        useFlexGap
        sx={{ flexWrap: 'wrap', alignItems: 'center', gap: 1 }}
      >
        <Typography variant="h5" sx={{ fontWeight: 700, flexGrow: 1 }}>
          {text.title}
        </Typography>
        <Button
          disabled={busy}
          onClick={() => void refresh(preset ? presetRange(preset) : query)}
        >
          {text.refresh}
        </Button>
        <Button
          variant="outlined"
          disabled={!snapshot?.durable || busy}
          onClick={() =>
            snapshot?.warnings.length
              ? setConfirmation('export')
              : void doExport()
          }
        >
          {text.export}
        </Button>
        <Button
          disabled={!snapshot || busy}
          onClick={() => {
            setSettings(snapshot?.settings)
            setManage(true)
          }}
        >
          {text.manage}
        </Button>
      </Stack>
      <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1 }}>
        {([1, 7, 30, 0] as const).map((days) => (
          <Button
            key={days}
            variant={preset === days ? 'contained' : 'text'}
            disabled={busy}
            onClick={() => {
              setPreset(days)
              if (days) void refresh(presetRange(days))
            }}
          >
            {
              text[
                days === 1
                  ? 'today'
                  : days === 7
                    ? 'week'
                    : days === 30
                      ? 'month'
                      : 'custom'
              ]
            }
          </Button>
        ))}
      </Stack>
      {!preset && (
        <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1 }}>
          <TextField
            type="date"
            size="small"
            label={text.start}
            value={draftStart}
            onChange={(event) => setDraftStart(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            type="date"
            size="small"
            label={text.end}
            value={draftEnd}
            onChange={(event) => setDraftEnd(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <Button
            disabled={busy}
            onClick={() => {
              const range = dateRange(draftStart, draftEnd)
              if (range) void refresh(range)
              else setError(text.rangeError)
            }}
          >
            {text.apply}
          </Button>
        </Stack>
      )}
      {!preset &&
        (draftStart !== calendarDate(query.start, query.timezone) ||
          draftEnd !== calendarDate(query.end - 1, query.timezone)) && (
          <Typography variant="body2" color="text.secondary">
            {text.pendingDates}
          </Typography>
        )}
      <Typography variant="body2" color="text.secondary">
        {calendarDate(query.start, query.timezone)} —{' '}
        {calendarDate(query.end - 1, query.timezone)} · {query.timezone}
      </Typography>
      {busy && <LinearProgress aria-label={text.loading} />}
      {error && (
        <Alert
          severity="error"
          action={
            <Button
              disabled={busy}
              onClick={() => void refresh(preset ? presetRange(preset) : query)}
            >
              {text.retry}
            </Button>
          }
        >
          {text.failure}
          <Box component="details">
            <summary>{text.details}</summary>
            <Typography sx={{ overflowWrap: 'anywhere' }}>{error}</Typography>
          </Box>
        </Alert>
      )}
      {notice && (
        <Alert severity="success" onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}
      {!snapshot && !busy && !error && (
        <Typography>{text.noSamples}</Typography>
      )}
      {snapshot && result && (
        <>
          <Stack
            direction="row"
            useFlexGap
            sx={{ flexWrap: 'wrap', gap: 1, alignItems: 'center' }}
          >
            <Chip
              size="small"
              label={
                !snapshot.settings.enabled
                  ? text.paused
                  : snapshot.collecting
                    ? text.collecting
                    : text.disconnected
              }
              color={snapshot.collecting ? 'success' : 'default'}
            />
            <Typography variant="caption" color="text.secondary">
              {text.updated}: {showTime(loadedAt)}
            </Typography>
          </Stack>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' },
              gap: 1.5,
            }}
          >
            {metrics.map((metric) => (
              <Paper
                key={metric}
                variant="outlined"
                sx={{ p: 2.5, minWidth: 0 }}
              >
                <Typography color="text.secondary" variant="body2">
                  {text[metric]}
                </Typography>
                <Typography
                  sx={{
                    fontSize: 'clamp(22px, 3vw, 32px)',
                    fontWeight: 700,
                    fontVariantNumeric: 'tabular-nums',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {bytes(amount(result.totals, metric))}
                </Typography>
              </Paper>
            ))}
          </Box>
          <Typography variant="caption" color="text.secondary">
            {text.scope}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {text.known} · {text[query.dimension]} ·{' '}
            {denominator
              ? `${((knownBytes / denominator) * 100).toFixed(1)}%`
              : '—'}
          </Typography>
          {(!snapshot.settings.recordTargets ||
            !snapshot.settings.recordProcesses) && (
            <Alert severity="info">
              {text.recordingOff}:{' '}
              {[
                !snapshot.settings.recordTargets && text.target,
                !snapshot.settings.recordProcesses && text.process,
              ]
                .filter(Boolean)
                .join(' / ')}
              . {text.privacy}
            </Alert>
          )}
          <Box
            component="details"
            sx={{ fontSize: 14, color: 'text.secondary' }}
          >
            <summary>
              {text.coverage}:{' '}
              {Math.min(
                100,
                (result.covered /
                  Math.max(1, Math.min(query.end, loadedAt) - query.start)) *
                  100,
              ).toFixed(1)}
              % ·{' '}
              {result.covered >= expectedCoverage && expectedCoverage > 0
                ? text.observed
                : text.partial}
            </summary>
            <Typography variant="body2">{text.coverageHelp}</Typography>
            {snapshot.coverage.some((range) => !range.consistent) && (
              <Typography variant="body2">{text.inconsistent}</Typography>
            )}
            {snapshot.coverage.some(
              (range) =>
                range.offset !== -new Date(range.end).getTimezoneOffset() * 60,
            ) && (
              <Typography variant="body2">
                {query.timezone} · UTC offsets:{' '}
                {[
                  ...new Set(
                    snapshot.coverage.map((range) => range.offset / 3600),
                  ),
                ].join(', ')}
              </Typography>
            )}
          </Box>
          {snapshot.warnings.length > 0 && (
            <Alert severity="warning">
              {text.warnings}
              <Box component="details">
                <summary>{text.details}</summary>
                {snapshot.warnings.map((warning) => (
                  <Typography key={warning} sx={{ overflowWrap: 'anywhere' }}>
                    {warning}
                  </Typography>
                ))}
              </Box>
            </Alert>
          )}
          {!snapshot.durable && <Alert severity="error">{text.unsaved}</Alert>}
          <Stack direction={{ xs: 'column', md: 'row' }} sx={{ gap: 1.5 }}>
            <TextField
              size="small"
              fullWidth
              label={text.search}
              slotProps={{
                input: {
                  endAdornment: query.search ? (
                    <Button
                      size="small"
                      onClick={() => setQuery({ ...query, search: '' })}
                    >
                      {text.clearSearch}
                    </Button>
                  ) : undefined,
                },
              }}
              value={query.search}
              onChange={(event) =>
                setQuery({ ...query, search: event.target.value })
              }
            />
            <Autocomplete
              multiple
              disableCloseOnSelect
              options={groups}
              value={query.groups ?? groups}
              onChange={(_, value) => setQuery({ ...query, groups: value })}
              sx={{ minWidth: { md: 260 }, width: { md: 360 } }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  size="small"
                  label={`${text.groups}${query.groups === null ? ` · ${text.all}` : ''}`}
                />
              )}
              renderOption={(props, option, { selected }) => {
                const { key, ...rest } = props
                return (
                  <li key={key} {...rest}>
                    <Checkbox checked={selected} />
                    {option}
                  </li>
                )
              }}
            />
          </Stack>
          <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1 }}>
            <Button
              size="small"
              onClick={() => setQuery({ ...query, groups: [...groups] })}
            >
              {text.selectAll}
            </Button>
            <Button
              size="small"
              onClick={() => setQuery({ ...query, groups: [] })}
            >
              {text.none}
            </Button>
            <Button
              size="small"
              onClick={() => setQuery({ ...query, groups: null })}
            >
              {text.all}
            </Button>
            <Button
              size="small"
              onClick={() => {
                setQuery({ ...query, search: '', groups: null })
                setAll(false)
              }}
            >
              {text.reset}
            </Button>
          </Stack>
          {query.groups !== null && (
            <Stack
              direction="row"
              useFlexGap
              sx={{ flexWrap: 'wrap', gap: 0.5 }}
            >
              {query.groups.map((group) => (
                <Chip
                  key={group}
                  label={group}
                  onDelete={() =>
                    setQuery({
                      ...query,
                      groups: query.groups!.filter((value) => value !== group),
                    })
                  }
                  sx={{
                    height: 'auto',
                    '& .MuiChip-label': {
                      whiteSpace: 'normal',
                      overflowWrap: 'anywhere',
                      py: 0.5,
                    },
                  }}
                />
              ))}
            </Stack>
          )}
          {result.ungroupedExcluded && (
            <Alert severity="info">{text.excluded}</Alert>
          )}
          <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
            <Stack
              direction="row"
              useFlexGap
              sx={{
                flexWrap: 'wrap',
                gap: 1,
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Typography sx={{ fontWeight: 600 }}>{text.trend}</Typography>
              <TextField
                select
                size="small"
                label={text.metric}
                value={query.metric}
                onChange={(event) =>
                  setQuery({ ...query, metric: event.target.value as Metric })
                }
              >
                {metrics.map((metric) => (
                  <MenuItem key={metric} value={metric}>
                    {text[metric]}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
            <Box sx={{ overflowX: 'auto', mt: 2 }}>
              <Stack
                direction="row"
                sx={{
                  gap: 0.5,
                  minWidth: Math.max(480, buckets.length * 22),
                  height: 180,
                  alignItems: 'stretch',
                }}
              >
                {buckets.map((bucket) => {
                  const value = amount(bucket, query.metric)
                  const partial =
                    bucket.covered <
                    Math.max(0, Math.min(bucket.end, loadedAt) - bucket.start)
                  const composition = rank(bucket.records, {
                    ...query,
                    order: 'default',
                  })
                  const pieces = leaders.map((leader) => ({
                    key: leader.key,
                    value: amount(
                      composition.find((row) => row.key === leader.key) ?? {
                        upload: 0,
                        download: 0,
                      },
                      query.metric,
                    ),
                  }))
                  const remainder =
                    value - pieces.reduce((sum, piece) => sum + piece.value, 0)
                  return (
                    <Box
                      key={bucket.start}
                      component="button"
                      type="button"
                      aria-label={`${showTime(bucket.start)} — ${showTime(bucket.end)} · ${bytes(value)} · ${bucket.covered ? text.observed : text.noCoverage}`}
                      onClick={() =>
                        setDetails({
                          title: `${text.timeDetails} · ${showTime(bucket.start)}`,
                          interval: { start: bucket.start, end: bucket.end },
                        })
                      }
                      sx={{
                        flex: 1,
                        p: 0,
                        minWidth: 15,
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: 0.5,
                        color: 'text.primary',
                        cursor: 'pointer',
                        bgcolor: 'background.default',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'flex-end',
                        overflow: 'hidden',
                        backgroundImage: partial
                          ? 'repeating-linear-gradient(135deg, transparent, transparent 5px, #88888822 5px, #88888822 7px)'
                          : 'none',
                        '&:focus-visible': {
                          outline: '3px solid',
                          outlineColor: 'primary.main',
                          outlineOffset: 1,
                        },
                      }}
                    >
                      {remainder > 0 && (
                        <Box
                          sx={{
                            height: `${(remainder / peak) * 100}%`,
                            bgcolor: 'text.disabled',
                            minHeight: 1,
                          }}
                        />
                      )}
                      {pieces
                        .filter((piece) => piece.value > 0)
                        .map((piece) => (
                          <Box
                            key={piece.key}
                            sx={{
                              height: `${(piece.value / peak) * 100}%`,
                              bgcolor: color(piece.key),
                              opacity:
                                !highlight || highlight === piece.key ? 1 : 0.2,
                              minHeight: 1,
                            }}
                          />
                        ))}
                      {!value && bucket.covered > 0 && (
                        <Box sx={{ height: 2, bgcolor: 'success.main' }} />
                      )}
                    </Box>
                  )
                })}
              </Stack>
              <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                <Typography variant="caption">
                  {showTime(query.start)}
                </Typography>
                <Typography variant="caption">
                  {showTime(query.end - 1)}
                </Typography>
              </Stack>
            </Box>
            <Stack
              direction="row"
              useFlexGap
              sx={{ flexWrap: 'wrap', gap: 1, mt: 1 }}
            >
              {leaders.map((row) => (
                <Button
                  key={row.key}
                  size="small"
                  variant={highlight === row.key ? 'outlined' : 'text'}
                  aria-pressed={highlight === row.key}
                  onClick={() =>
                    setHighlight(highlight === row.key ? undefined : row.key)
                  }
                  sx={{
                    color: color(row.key),
                    maxWidth: '100%',
                    overflowWrap: 'anywhere',
                    textAlign: 'left',
                  }}
                >
                  {label(row, query.dimension)}
                </Button>
              ))}
              <Typography variant="caption" color="text.secondary">
                {text.remaining} ·{' '}
                {Math.max(0, result.ranking.length - leaders.length)}
              </Typography>
            </Stack>
          </Paper>
          <Stack
            direction="row"
            useFlexGap
            sx={{ flexWrap: 'wrap', alignItems: 'center', gap: 1 }}
          >
            <Typography sx={{ fontWeight: 600, flexGrow: 1 }}>
              {text.ranking}
            </Typography>
            <TextField
              size="small"
              select
              value={query.order}
              onChange={(event) =>
                setQuery({
                  ...query,
                  order: event.target.value as Query['order'],
                })
              }
              label={text.ranking}
            >
              {(['default', 'ascending', 'name'] as const).map((order) => (
                <MenuItem key={order} value={order}>
                  {text[order]}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <Tabs
            value={query.dimension}
            onChange={(_, dimension: Dimension) => {
              setQuery({ ...query, dimension })
              setAll(false)
            }}
            variant="scrollable"
          >
            {dimensions.map((dimension) => (
              <Tab key={dimension} value={dimension} label={text[dimension]} />
            ))}
          </Tabs>
          {!result.records.length && (
            <Alert severity="info">
              {result.periodHasRecords
                ? text.noMatch
                : result.covered
                  ? text.zero
                  : text.noSamples}
            </Alert>
          )}
          {!!displayed.length && (
            <TableContainer
              component={Paper}
              variant="outlined"
              sx={{ overflowX: 'auto' }}
            >
              <Table size="small" sx={{ minWidth: 540, tableLayout: 'fixed' }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ width: '55%' }}>
                      {text[query.dimension]}
                    </TableCell>
                    <TableCell>{text[query.metric]}</TableCell>
                    <TableCell>{text.share}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {displayed.map((row) => (
                    <TableRow key={row.key} hover>
                      <TableCell
                        sx={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}
                      >
                        <Button
                          onClick={() => openObject(row)}
                          sx={{
                            p: 0,
                            textTransform: 'none',
                            textAlign: 'left',
                            display: 'block',
                            userSelect: 'text',
                          }}
                        >
                          {label(row, query.dimension)}
                        </Button>
                        {query.dimension === 'process' && (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: 'block', overflowWrap: 'anywhere' }}
                          >
                            {row.identity.path ?? text.nameOnly}
                          </Typography>
                        )}
                        {row.identity.unattributed && (
                          <Typography variant="caption" color="text.secondary">
                            {text.unattributedHelp}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>
                        {bytes(amount(row, query.metric))}
                      </TableCell>
                      <TableCell>
                        {denominator
                          ? `${((amount(row, query.metric) / denominator) * 100).toFixed(1)}%`
                          : '—'}
                        <LinearProgress
                          variant="determinate"
                          value={
                            denominator
                              ? (amount(row, query.metric) / denominator) * 100
                              : 0
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          <Stack
            direction="row"
            useFlexGap
            sx={{ flexWrap: 'wrap', alignItems: 'center', gap: 1 }}
          >
            <Typography variant="caption">
              {text.showing}: {displayed.length} / {result.ranking.length}
            </Typography>
            {shown.length > 50 && (
              <Button onClick={() => setAll(!all)}>
                {all ? text.showLess : `${text.showAll} ${shown.length}`}
              </Button>
            )}
          </Stack>
          {all && (
            <TablePagination
              component="div"
              count={shown.length}
              page={rankingOffset}
              rowsPerPage={50}
              rowsPerPageOptions={[50]}
              onPageChange={(_, page) => setRankingPage(page)}
            />
          )}
          <Box
            component="details"
            onToggle={(event) => setCombinationsOpen(event.currentTarget.open)}
          >
            <summary>
              {text.combinations} · {result.records.length}
            </summary>
            {combinationsOpen && (
              <CombinationTable
                records={result.records}
                timezone={query.timezone}
                text={text}
                copy={copy}
              />
            )}
          </Box>
          <Typography variant="caption" color="text.secondary">
            {text.manualUpdates}
          </Typography>
        </>
      )}
      <Dialog
        open={!!details}
        onClose={() => setDetails(undefined)}
        fullWidth
        maxWidth="md"
        slotProps={{ paper: { sx: { m: { xs: 1, sm: 4 }, width: '100%' } } }}
      >
        <DialogTitle sx={{ overflowWrap: 'anywhere' }}>
          {details?.title}
        </DialogTitle>
        <DialogContent dividers>
          {notice && <Alert severity="success">{notice}</Alert>}
          {error && (
            <Alert severity="error">
              {text.failure} {error}
            </Alert>
          )}
          {details?.focus && (
            <Typography variant="body2" sx={{ mb: 2 }}>
              {text[details.focus.dimension]} · {details.title}
            </Typography>
          )}
          {detailResult && (
            <Stack spacing={2}>
              <Typography>
                {text.total}: {bytes(amount(detailResult.totals, 'total'))} ·{' '}
                {text.download}: {bytes(detailResult.totals.download)} ·{' '}
                {text.upload}: {bytes(detailResult.totals.upload)}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {text.coverageHelp}
              </Typography>
              <Typography variant="body2">
                {text.coverage}:{' '}
                {Math.min(
                  100,
                  (detailResult.covered /
                    Math.max(
                      1,
                      Math.min(
                        query.end,
                        details?.interval?.end ?? query.end,
                        loadedAt,
                      ) -
                        Math.max(
                          query.start,
                          details?.interval?.start ?? query.start,
                        ),
                    )) *
                    100,
                ).toFixed(1)}
                %
              </Typography>
              <Box component="details">
                <summary>{text.trend}</summary>
                <Box
                  sx={{
                    display: 'flex',
                    gap: 0.5,
                    height: 120,
                    overflowX: 'auto',
                    alignItems: 'end',
                  }}
                >
                  {detailBuckets.map((bucket) => (
                    <Box
                      component="button"
                      key={bucket.start}
                      type="button"
                      aria-label={`${showTime(bucket.start)} · ${bytes(amount(bucket, query.metric))} · ${bucket.covered ? text.observed : text.noCoverage}`}
                      onClick={() =>
                        setDetails({
                          ...details!,
                          interval: { start: bucket.start, end: bucket.end },
                        })
                      }
                      sx={{
                        flex: '1 0 16px',
                        height: '100%',
                        p: 0,
                        display: 'flex',
                        alignItems: 'end',
                        bgcolor: 'background.default',
                        border: '1px solid',
                        borderColor: 'divider',
                        cursor: 'pointer',
                      }}
                    >
                      <Box
                        sx={{
                          width: '100%',
                          bgcolor: 'primary.main',
                          minHeight: bucket.covered ? 2 : 0,
                          height: `${(amount(bucket, query.metric) / detailPeak) * 100}%`,
                        }}
                      />
                    </Box>
                  ))}
                </Box>
              </Box>
              <Typography variant="body2">{text.processHelp}</Typography>
              {dimensions.map((dimension) => (
                <Box key={dimension}>
                  <Typography sx={{ fontWeight: 600 }}>
                    {text[dimension]}
                  </Typography>
                  {rank(detailResult.records, { ...query, dimension }).map(
                    (row) => (
                      <Box
                        key={row.key}
                        sx={{
                          py: 1,
                          borderBottom: '1px solid',
                          borderColor: 'divider',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        <Typography sx={{ userSelect: 'text' }}>
                          {label(row, dimension)} ·{' '}
                          {bytes(amount(row, query.metric))}
                        </Typography>
                        {row.label && (
                          <Button
                            size="small"
                            onClick={() => void copy(row.label!)}
                          >
                            {text.copy}
                          </Button>
                        )}
                        {dimension === 'process' && (
                          <Typography sx={{ overflowWrap: 'anywhere' }}>
                            {text.path}: {row.identity.path ?? text.nameOnly}
                            {row.identity.path && (
                              <Button
                                size="small"
                                onClick={() => void copy(row.identity.path!)}
                              >
                                {text.copy}
                              </Button>
                            )}
                          </Typography>
                        )}
                      </Box>
                    ),
                  )}
                </Box>
              ))}
              <CombinationTable
                records={detailResult.records}
                timezone={query.timezone}
                text={text}
                copy={copy}
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            disabled={busy || !snapshot?.durable}
            onClick={() =>
              snapshot?.warnings.length
                ? setConfirmation('export')
                : void doExport()
            }
          >
            {text.export}
          </Button>
          <Button onClick={() => setDetails(undefined)}>{text.close}</Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={manage}
        onClose={() => {
          if (!busy) setManage(false)
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{text.manage}</DialogTitle>
        <DialogContent dividers>
          {error && (
            <Alert severity="error">
              {text.failure} {error}
            </Alert>
          )}
          {settings && (
            <Stack spacing={2}>
              {(['enabled', 'recordTargets', 'recordProcesses'] as const).map(
                (key) => (
                  <FormControlLabel
                    key={key}
                    label={text[key]}
                    control={
                      <Switch
                        disabled={busy}
                        checked={settings[key]}
                        onChange={(_, checked) =>
                          setSettings({ ...settings, [key]: checked })
                        }
                      />
                    }
                  />
                ),
              )}
              <TextField
                type="number"
                label={text.retention}
                value={settings.retentionDays}
                error={!settingsValid}
                slotProps={{ htmlInput: { min: 1, max: 366 } }}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    retentionDays: Number(event.target.value),
                  })
                }
              />
              <Typography variant="body2">{text.privacy}</Typography>
              <Divider />
              <Button
                color="error"
                disabled={busy}
                onClick={() => setConfirmation('clear')}
              >
                {text.clear}
              </Button>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setManage(false)}>
            {text.cancel}
          </Button>
          <Button
            disabled={busy || !settingsValid}
            onClick={() =>
              void action(async () => {
                try {
                  await api.configure(settings!)
                  setManage(false)
                } finally {
                  await refresh(query)
                }
              }, text.saved)
            }
          >
            {text.save}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={!!confirmation}
        onClose={() => {
          if (!busy) setConfirmation(undefined)
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {confirmation === 'clear' ? text.clear : text.export}
        </DialogTitle>
        <DialogContent>
          {confirmation === 'clear' ? text.clearConfirm : text.incompleteExport}
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setConfirmation(undefined)}>
            {text.cancel}
          </Button>
          <Button
            disabled={busy}
            color={confirmation === 'clear' ? 'error' : 'primary'}
            onClick={() => {
              if (confirmation === 'export') void doExport()
              else
                void action(async () => {
                  try {
                    await api.clear()
                  } finally {
                    setConfirmation(undefined)
                    setManage(false)
                    setDetails(undefined)
                    await refresh(query)
                  }
                }, text.cleared)
            }}
          >
            {confirmation === 'clear' ? text.confirm : text.export}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}

function CombinationTable({
  timezone,
  records,
  text,
  copy,
}: {
  timezone: string
  records: StatisticsSnapshot['records']
  text: typeof en
  copy: (value: string) => Promise<void>
}) {
  const [page, setPage] = useState(0)
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(records.length / 50) - 1),
  )
  return (
    <>
      <TableContainer
        sx={{ overflowX: 'auto', border: '1px solid', borderColor: 'divider' }}
      >
        <Table size="small" sx={{ minWidth: 780 }}>
          <TableHead>
            <TableRow>
              {(
                [
                  'sample',
                  'target',
                  'rawProcess',
                  'path',
                  'group',
                  'route',
                  'upload',
                  'download',
                ] as const
              ).map((key) => (
                <TableCell key={key}>{text[key]}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {records
              .slice(currentPage * 50, (currentPage + 1) * 50)
              .map((row) => (
                <TableRow
                  key={JSON.stringify([
                    row.at,
                    row.target,
                    row.process,
                    row.path,
                    row.group,
                    row.route,
                  ])}
                >
                  <TableCell>{formatTime(row.at, timezone)}</TableCell>
                  {(['target', 'process', 'path', 'group'] as const).map(
                    (field) => {
                      const value = row[field]
                      return (
                        <TableCell
                          key={field}
                          sx={{
                            minWidth: 100,
                            maxWidth: 260,
                            overflowWrap: 'anywhere',
                            userSelect: 'text',
                          }}
                        >
                          {value ??
                            (row.unattributed
                              ? text.unattributed
                              : text.unknown)}
                          {value && (
                            <Button
                              size="small"
                              onClick={() => void copy(value)}
                            >
                              {text.copy}
                            </Button>
                          )}
                        </TableCell>
                      )
                    },
                  )}
                  <TableCell>
                    {row.route === 'unknown'
                      ? text.unknownRoute
                      : text[row.route]}
                  </TableCell>
                  <TableCell>{bytes(row.upload)}</TableCell>
                  <TableCell>{bytes(row.download)}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination
        component="div"
        count={records.length}
        page={currentPage}
        rowsPerPage={50}
        rowsPerPageOptions={[50]}
        onPageChange={(_, nextPage) => setPage(nextPage)}
      />
    </>
  )
}
