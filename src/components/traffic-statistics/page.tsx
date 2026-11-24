import {
  ArrowBackRounded,
  ClearRounded,
  MoreHorizRounded,
  SearchRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  LinearProgress,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  Tooltip,
  Typography,
} from '@mui/material'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  BasePage,
  BaseStyledSelect,
  BaseStyledTextField,
} from '@/components/base'
import en from '@/locales/en/trafficStatistics.json'
import type { StatisticsApi } from '@/services/traffic-statistics/api'
import {
  initialQuery,
  type TrafficQuery,
  type TrafficSnapshot,
} from '@/services/traffic-statistics/model'

const bytes = (value: number) => {
  if (!value) return '0 B'
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit ? 2 : 0 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`
}
const failureText = (error: unknown) =>
  error && typeof error === 'object' && 'detail' in error
    ? String(error.detail)
    : String(error)

function chartDays(snapshot: TrafficSnapshot | undefined) {
  if (!snapshot) return []
  const today = new Intl.DateTimeFormat('sv-SE', {
    timeZone: snapshot.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(snapshot.end - 1)
  const end = Date.parse(today)
  const usage = new Map(snapshot.daily.map((day) => [day.date, day]))
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(end - (6 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10)
    return usage.get(date) ?? { date, upload: 0, download: 0 }
  })
}

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
      t(`trafficStatistics.${key}`, { defaultValue: en[key] }),
    ]),
  ) as typeof en
  const [query, setQuery] = useState(initialQuery)
  const [search, setSearch] = useState('')
  const [snapshot, setSnapshot] = useState<TrafficSnapshot>()
  const [busy, setBusy] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const requestRef = useRef(0)
  const pendingRef = useRef(false)
  const mutationRef = useRef(false)
  const aliveRef = useRef(true)
  const currentRef = useRef(query)
  currentRef.current = query

  const load = useCallback(
    async (value: TrafficQuery) => {
      const id = ++requestRef.current
      pendingRef.current = true
      setBusy(true)
      try {
        const next = await api.read(value)
        if (aliveRef.current && id === requestRef.current) {
          setSnapshot(next)
          setError('')
        }
      } catch (failure) {
        if (aliveRef.current && id === requestRef.current)
          setError(failureText(failure))
      } finally {
        if (aliveRef.current && id === requestRef.current) {
          pendingRef.current = false
          setBusy(false)
        }
      }
    },
    [api],
  )

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      requestRef.current += 1
    }
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(
      () => setQuery((value) => ({ ...value, search, page: 0 })),
      300,
    )
    return () => window.clearTimeout(timer)
  }, [search])
  useEffect(() => {
    void load(query)
  }, [query, load])
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden && !pendingRef.current && !mutationRef.current)
        void load(currentRef.current)
    }
    const timer = window.setInterval(refresh, 5000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [load])

  const action = async (operation: () => Promise<void>) => {
    if (mutationRef.current) return
    mutationRef.current = true
    requestRef.current += 1
    setMutating(true)
    setError('')
    try {
      await operation()
      await load(currentRef.current)
    } catch (failure) {
      if (aliveRef.current) setError(failureText(failure))
    } finally {
      mutationRef.current = false
      if (aliveRef.current) setMutating(false)
    }
  }
  const change = (patch: Partial<TrafficQuery>) => {
    setSnapshot(undefined)
    setQuery((previous) => ({ ...previous, ...patch, page: 0 }))
  }
  const metrics = ['download', 'upload', 'total'] as const
  const detail = query.target !== null
  const unknown = query.byProcess ? text.unknownProcess : text.unknownTarget
  const label = query.target || unknown
  const count = snapshot
    ? detail
      ? snapshot.matchedDetails
      : snapshot.matchedTargets
    : 0
  const days = chartDays(snapshot)
  const maxDaily = Math.max(1, ...days.map((day) => day.download + day.upload))
  const totals = snapshot?.totals
  const [menu, setMenu] = useState<HTMLElement | null>(null)

  return (
    <BasePage
      full
      title={text.title}
      header={
        <Stack
          direction="row"
          spacing={{ xs: 1, sm: 2 }}
          sx={{
            alignItems: 'center',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
          }}
        >
          {totals &&
            metrics.map((metric) => (
              <Typography
                key={metric}
                variant="body2"
                sx={{
                  whiteSpace: 'nowrap',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <Box component="span" color="text.secondary">
                  {text[metric]}{' '}
                </Box>
                <strong>
                  {bytes(
                    metric === 'total'
                      ? totals.download + totals.upload
                      : totals[metric],
                  )}
                </strong>
              </Typography>
            ))}
          <IconButton
            size="small"
            aria-label={text.actions}
            aria-haspopup="menu"
            aria-expanded={Boolean(menu)}
            onClick={(event) => setMenu(event.currentTarget)}
          >
            <MoreHorizRounded fontSize="small" />
          </IconButton>
          <Menu
            anchorEl={menu}
            open={Boolean(menu)}
            onClose={() => setMenu(null)}
          >
            <MenuItem
              disabled={busy || mutating}
              onClick={() => {
                setMenu(null)
                void load(query)
              }}
            >
              {text.refresh}
            </MenuItem>
            <MenuItem
              disabled={!snapshot || mutating}
              onClick={() => {
                setMenu(null)
                void action(() => api.export(query))
              }}
            >
              {text.export}
            </MenuItem>
            <MenuItem
              disabled={!snapshot || mutating}
              onClick={() => {
                setMenu(null)
                setConfirm(true)
              }}
            >
              {text.clear}
            </MenuItem>
          </Menu>
        </Stack>
      }
    >
      <Stack spacing={1.5} sx={{ p: 1.25, minWidth: 0, userSelect: 'text' }}>
        {preview && <Alert severity="info">{text.preview}</Alert>}
        <Stack
          direction="row"
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}
        >
          <ButtonGroup size="small" aria-label={text.title}>
            <Button
              variant={query.byProcess ? 'contained' : 'outlined'}
              aria-pressed={query.byProcess}
              onClick={() => change({ byProcess: true, target: null })}
            >
              {text.apps}
            </Button>
            <Button
              variant={query.byProcess ? 'outlined' : 'contained'}
              aria-pressed={!query.byProcess}
              onClick={() => change({ byProcess: false, target: null })}
            >
              {text.addresses}
            </Button>
          </ButtonGroup>
          <BaseStyledSelect
            value={query.period}
            inputProps={{ 'aria-label': text.period }}
            onChange={(event) =>
              change({ period: event.target.value as TrafficQuery['period'] })
            }
          >
            {(['today', 'hour', 'week', 'month'] as const).map((period) => (
              <MenuItem key={period} value={period}>
                {text[period]}
              </MenuItem>
            ))}
          </BaseStyledSelect>
          <BaseStyledSelect
            value={query.route}
            inputProps={{ 'aria-label': text.route }}
            onChange={(event) =>
              change({ route: event.target.value as TrafficQuery['route'] })
            }
          >
            {(['proxy', 'direct', 'unknown'] as const).map((route) => (
              <MenuItem key={route} value={route}>
                {text[route]}
              </MenuItem>
            ))}
          </BaseStyledSelect>
          <Box sx={{ flex: '1 1 180px' }}>
            <BaseStyledTextField
              value={search}
              placeholder={text.search}
              onChange={(event) => setSearch(event.target.value)}
              slotProps={{
                htmlInput: { 'aria-label': text.search, maxLength: 170 },
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchRounded fontSize="small" />
                    </InputAdornment>
                  ),
                  endAdornment: search && (
                    <IconButton
                      size="small"
                      aria-label={text.reset}
                      onClick={() => setSearch('')}
                    >
                      <ClearRounded fontSize="small" />
                    </IconButton>
                  ),
                },
              }}
            />
          </Box>
        </Stack>
        {error && (
          <Alert
            severity="error"
            action={
              <Button onClick={() => void load(query)}>{text.retry}</Button>
            }
          >
            {text.failure}
            <Box sx={{ overflowWrap: 'anywhere' }}>{error}</Box>
          </Alert>
        )}
        {snapshot && !snapshot.collecting && (
          <Alert severity="info">{text.disconnected}</Alert>
        )}
        {snapshot?.warning && (
          <Alert severity="warning">{snapshot.warning}</Alert>
        )}
        {Boolean(snapshot?.gapMillis) && (
          <Typography variant="caption" color="text.secondary">
            {text.gaps}: {Math.ceil((snapshot?.gapMillis ?? 0) / 60000)}{' '}
            {text.minutes}
          </Typography>
        )}
        <Paper variant="outlined" sx={{ borderRadius: 2, px: 1.5, py: 1 }}>
          <Stack
            direction="row"
            spacing={1.25}
            sx={{ justifyContent: 'flex-end' }}
          >
            {(['download', 'upload'] as const).map((metric) => (
              <Stack
                key={metric}
                direction="row"
                sx={{ alignItems: 'center' }}
                spacing={0.5}
              >
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: 0.5,
                    bgcolor:
                      metric === 'download' ? 'primary.main' : 'warning.main',
                  }}
                />
                <Typography variant="caption">{text[metric]}</Typography>
              </Stack>
            ))}
          </Stack>
          <Box
            role="group"
            aria-label={text.daily}
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
              gap: 0.5,
              minHeight: 86,
            }}
          >
            {days.map((day) => (
              <Stack
                key={day.date}
                sx={{ alignItems: 'center' }}
                spacing={0.25}
              >
                <Tooltip
                  title={
                    day.date +
                    ' · ' +
                    text.download +
                    ' ' +
                    bytes(day.download) +
                    ' · ' +
                    text.upload +
                    ' ' +
                    bytes(day.upload)
                  }
                >
                  <Stack
                    role="img"
                    aria-label={
                      day.date + ': ' + bytes(day.download + day.upload)
                    }
                    sx={{
                      justifyContent: 'flex-end',
                      height: 64,
                      width: 'min(65%, 38px)',
                    }}
                  >
                    <Box
                      sx={{
                        height: (day.upload / maxDaily) * 60,
                        bgcolor: 'warning.main',
                      }}
                    />
                    <Box
                      sx={{
                        height: (day.download / maxDaily) * 60,
                        bgcolor: 'primary.main',
                      }}
                    />
                  </Stack>
                </Tooltip>
                <Typography variant="caption" color="text.secondary">
                  {day.date.slice(5).replace('-', '/')}
                </Typography>
              </Stack>
            ))}
          </Box>
        </Paper>
        <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
          <Stack
            direction="row"
            spacing={1}
            sx={{
              alignItems: 'center',
              px: 1.5,
              minHeight: 42,
              borderBottom: 1,
              borderColor: 'divider',
            }}
          >
            {detail && (
              <IconButton
                size="small"
                aria-label={text.back}
                onClick={() => change({ target: null })}
              >
                <ArrowBackRounded fontSize="small" />
              </IconButton>
            )}
            <Typography
              variant="subtitle2"
              sx={{ flex: 1, overflowWrap: 'anywhere' }}
            >
              {detail
                ? label
                : query.byProcess
                  ? text.appRanking
                  : text.addressRanking}
            </Typography>
            {detail && query.target && (
              <Button
                size="small"
                onClick={() => void action(() => api.copy(label))}
              >
                {text.copy}
              </Button>
            )}
          </Stack>
          <TableContainer>
            <Table
              size="small"
              sx={{
                minWidth: detail ? 530 : 350,
                '& .MuiTableRow-root': { height: 40 },
                '& .MuiTableCell-root': {
                  fontSize: 13,
                  py: 0,
                  px: 1,
                  fontVariantNumeric: 'tabular-nums',
                },
                '& .MuiTableCell-head': { fontWeight: 600 },
              }}
            >
              <TableHead>
                <TableRow>
                  <TableCell>
                    {(detail ? !query.byProcess : query.byProcess)
                      ? text.appProcess
                      : text.target}
                  </TableCell>
                  {detail && <TableCell>{text.ruleChain}</TableCell>}
                  {metrics.map((metric) => (
                    <TableCell
                      key={metric}
                      align="right"
                      sortDirection={query.metric === metric ? 'desc' : false}
                    >
                      <TableSortLabel
                        active={query.metric === metric}
                        direction="desc"
                        onClick={() => change({ metric })}
                      >
                        {text[metric]}
                      </TableSortLabel>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {!detail &&
                  snapshot?.targets.map((row) => (
                    <TableRow hover key={row.target}>
                      <TableCell sx={{ overflowWrap: 'anywhere' }}>
                        <Button
                          size="small"
                          sx={{
                            p: 0,
                            minWidth: 0,
                            fontSize: 'inherit',
                            textTransform: 'none',
                            textAlign: 'left',
                          }}
                          onClick={() => change({ target: row.target })}
                        >
                          {row.target || unknown}
                        </Button>
                      </TableCell>
                      <TableCell align="right">{bytes(row.download)}</TableCell>
                      <TableCell align="right">{bytes(row.upload)}</TableCell>
                      <TableCell align="right">
                        <strong>{bytes(row.download + row.upload)}</strong>
                      </TableCell>
                    </TableRow>
                  ))}
                {detail &&
                  snapshot?.details.map((row) => (
                    <TableRow
                      hover
                      key={JSON.stringify([
                        row.target,
                        row.ip,
                        row.process,
                        row.path,
                        row.rule,
                        row.rulePayload,
                        row.chain,
                      ])}
                    >
                      <TableCell sx={{ overflowWrap: 'anywhere' }}>
                        {query.byProcess
                          ? row.target || text.unknownTarget
                          : row.process || text.unknownProcess}
                        <Typography
                          component="div"
                          variant="caption"
                          color="text.secondary"
                        >
                          {query.byProcess ? row.ip : row.path}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ overflowWrap: 'anywhere' }}>
                        {row.rule || text.unknownRule}
                        {row.rulePayload && ' · ' + row.rulePayload}
                        <Typography
                          component="div"
                          variant="caption"
                          color="text.secondary"
                        >
                          {row.chain}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">{bytes(row.download)}</TableCell>
                      <TableCell align="right">{bytes(row.upload)}</TableCell>
                      <TableCell align="right">
                        <strong>{bytes(row.download + row.upload)}</strong>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </TableContainer>
          {busy && !snapshot && <LinearProgress aria-label={text.loading} />}
          {snapshot && count === 0 && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ px: 1.5, py: 2 }}
            >
              {query.search
                ? text.noMatch
                : snapshot.observedAt
                  ? text.noTraffic
                  : text.noSamples}
            </Typography>
          )}
          {count > 50 && (
            <TablePagination
              component="div"
              rowsPerPageOptions={[50]}
              rowsPerPage={50}
              count={count}
              page={Math.min(query.page, Math.ceil(count / 50) - 1)}
              onPageChange={(_, page) =>
                setQuery((previous) => ({ ...previous, page }))
              }
            />
          )}
        </Paper>
        <Typography variant="caption" color="text.secondary">
          {text.limitations}
        </Typography>
      </Stack>
      <Dialog
        open={confirm}
        onClose={() => {
          if (!mutating) setConfirm(false)
        }}
      >
        <DialogTitle>{text.clear}</DialogTitle>
        <DialogContent>{text.clearConfirm}</DialogContent>
        <DialogActions>
          <Button disabled={mutating} onClick={() => setConfirm(false)}>
            {text.cancel}
          </Button>
          <Button
            color="error"
            disabled={mutating}
            onClick={() =>
              void action(async () => {
                await api.clear()
                setConfirm(false)
                setQuery((previous) => ({ ...previous, page: 0 }))
              })
            }
          >
            {text.clear}
          </Button>
        </DialogActions>
      </Dialog>
    </BasePage>
  )
}
