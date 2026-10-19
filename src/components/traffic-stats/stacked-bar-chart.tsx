import { Box, Paper, Typography, useTheme } from '@mui/material'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import parseTraffic from '@/utils/parse-traffic'

import { metricValue, type TrafficMetric } from './shared'

interface Props {
  buckets: ITrafficStatsBucket[]
  /** 图例顺序，同时决定堆叠顺序与配色索引 */
  orderedKeys: string[]
  colorOf: (key: string) => string
  labelOf: (key: string) => string
  granularity: TrafficStatsGranularity
  metric: TrafficMetric
  height?: number
}

const PADDING = { top: 12, right: 12, bottom: 24, left: 60 }
const BAR_GAP_RATIO = 0.22
const Y_TICK_COUNT = 4

const formatBytes = (value: number) => parseTraffic(value).join(' ')

/** 把最大值抬到 1/2/5×10^n 的整档，Y 轴刻度才好看。 */
const niceCeil = (value: number) => {
  if (value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const magnitude = 10 ** exponent
  const normalized = value / magnitude
  const stepped =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return stepped * magnitude
}

const syncCanvasSize = (
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
) => {
  const dpr = window.devicePixelRatio || 1
  const nextWidth = Math.max(1, Math.round(width * dpr))
  const nextHeight = Math.max(1, Math.round(height * dpr))
  if (canvas.width !== nextWidth) canvas.width = nextWidth
  if (canvas.height !== nextHeight) canvas.height = nextHeight
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`

  const ctx = canvas.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

export const StackedBarChart = ({
  buckets,
  orderedKeys,
  colorOf,
  labelOf,
  granularity,
  metric,
  height = 220,
}: Props) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height })
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [pointer, setPointer] = useState({ x: 0, y: 0 })

  // 每个桶按 orderedKeys 展开成定长数组，绘制与 tooltip 共用
  const series = useMemo(
    () =>
      buckets.map((bucket) => {
        const byKey = new Map(bucket.items.map((item) => [item.key, item]))
        return orderedKeys.map((key) => {
          const item = byKey.get(key)
          return item ? metricValue(item, metric) : 0
        })
      }),
    [buckets, orderedKeys, metric],
  )

  const maxTotal = useMemo(
    () =>
      series.reduce(
        (max, values) =>
          Math.max(
            max,
            values.reduce((sum, value) => sum + value, 0),
          ),
        0,
      ),
    [series],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setSize({ width: entry.contentRect.width, height })
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [height])

  const formatBucketLabel = useCallback(
    (ts: number) =>
      dayjs(ts).format(granularity === 'hour' ? 'HH:mm' : 'MM-DD'),
    [granularity],
  )

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width <= 0) return
    const ctx = syncCanvasSize(canvas, size.width, size.height)
    if (!ctx) return

    ctx.clearRect(0, 0, size.width, size.height)

    const plotWidth = size.width - PADDING.left - PADDING.right
    const plotHeight = size.height - PADDING.top - PADDING.bottom
    if (plotWidth <= 0 || plotHeight <= 0) return

    const axisColor = theme.palette.divider
    const textColor = theme.palette.text.secondary
    const scaleMax = niceCeil(maxTotal)

    // 网格线与 Y 轴刻度
    ctx.font = '11px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'right'
    for (let tick = 0; tick <= Y_TICK_COUNT; tick += 1) {
      const value = (scaleMax / Y_TICK_COUNT) * tick
      const y = PADDING.top + plotHeight - (plotHeight * tick) / Y_TICK_COUNT
      ctx.strokeStyle = axisColor
      ctx.globalAlpha = tick === 0 ? 0.6 : 0.25
      ctx.beginPath()
      ctx.moveTo(PADDING.left, y)
      ctx.lineTo(PADDING.left + plotWidth, y)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillStyle = textColor
      ctx.fillText(formatBytes(value), PADDING.left - 8, y)
    }

    if (series.length === 0) return

    const slotWidth = plotWidth / series.length
    const barWidth = Math.max(1, slotWidth * (1 - BAR_GAP_RATIO))

    // 悬停高亮铺在柱子底下
    if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < series.length) {
      ctx.fillStyle = theme.palette.action.hover
      ctx.fillRect(
        PADDING.left + slotWidth * hoverIndex,
        PADDING.top,
        slotWidth,
        plotHeight,
      )
    }

    series.forEach((values, bucketIndex) => {
      const x =
        PADDING.left + slotWidth * bucketIndex + (slotWidth - barWidth) / 2
      if (buckets[bucketIndex]?.observed === false) {
        // Hatching marks a gap in collection, rather than a measured zero.
        ctx.save()
        ctx.beginPath()
        ctx.rect(x, PADDING.top, barWidth, plotHeight)
        ctx.clip()
        ctx.strokeStyle = textColor
        ctx.globalAlpha = 0.2
        for (let offset = -plotHeight; offset < barWidth; offset += 8) {
          ctx.beginPath()
          ctx.moveTo(x + offset, PADDING.top + plotHeight)
          ctx.lineTo(x + offset + plotHeight, PADDING.top)
          ctx.stroke()
        }
        ctx.restore()
        return
      }
      let baseline = PADDING.top + plotHeight

      values.forEach((value, keyIndex) => {
        if (value <= 0) return
        const barHeight = (value / scaleMax) * plotHeight
        const key = orderedKeys[keyIndex]
        if (key === undefined) return
        ctx.fillStyle = colorOf(key)
        ctx.fillRect(x, baseline - barHeight, barWidth, barHeight)
        baseline -= barHeight
      })
    })

    // X 轴标签：按可用宽度稀释，避免文字挤在一起
    const labelStep = Math.max(1, Math.ceil((series.length * 40) / plotWidth))
    ctx.fillStyle = textColor
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    buckets.forEach((bucket, index) => {
      if (index % labelStep !== 0) return
      const x = PADDING.left + slotWidth * index + slotWidth / 2
      ctx.fillText(
        formatBucketLabel(bucket.ts),
        x,
        PADDING.top + plotHeight + 7,
      )
    })
  }, [
    buckets,
    colorOf,
    formatBucketLabel,
    hoverIndex,
    maxTotal,
    orderedKeys,
    series,
    size.height,
    size.width,
    theme.palette.action.hover,
    theme.palette.divider,
    theme.palette.text.secondary,
  ])

  useEffect(() => {
    draw()
  }, [draw])

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current
    if (!container || series.length === 0) return

    const rect = container.getBoundingClientRect()
    const x = event.clientX - rect.left
    const plotWidth = rect.width - PADDING.left - PADDING.right
    if (plotWidth <= 0) return

    const index = Math.floor(((x - PADDING.left) / plotWidth) * series.length)
    setHoverIndex(index >= 0 && index < series.length ? index : null)
    setPointer({ x, y: event.clientY - rect.top })
  }

  const hoveredBucket = hoverIndex === null ? undefined : buckets[hoverIndex]
  const hoveredValues = hoverIndex === null ? undefined : series[hoverIndex]

  const tooltipRows = useMemo(() => {
    if (!hoveredValues) return []
    return orderedKeys
      .map((key, index) => ({ key, value: hoveredValues[index] ?? 0 }))
      .filter((row) => row.value > 0)
      .sort((left, right) => right.value - left.value)
  }, [hoveredValues, orderedKeys])

  const bucketSummary = hoveredBucket
    ? `${dayjs(hoveredBucket.ts).format('YYYY-MM-DD HH:mm')}: ${
        hoveredBucket.observed === false
          ? t('trafficStats.chart.notObserved')
          : `${t('trafficStats.chart.total')} ${formatBytes((hoveredValues ?? []).reduce((sum, value) => sum + value, 0))}. ${tooltipRows.map((row) => `${labelOf(row.key)} ${formatBytes(row.value)}`).join(', ')}`
      }`
    : ''

  return (
    <Box>
      <Box
        ref={containerRef}
        tabIndex={0}
        role="group"
        aria-label={t('trafficStats.chart.description')}
        sx={{
          position: 'relative',
          width: '100%',
          height,
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIndex(null)}
        onFocus={() =>
          setHoverIndex((current) => current ?? (buckets.length ? 0 : null))
        }
        onKeyDown={(event) => {
          if (
            !buckets.length ||
            !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(
              event.key,
            )
          )
            return
          event.preventDefault()
          if (event.key === 'Escape') {
            setHoverIndex(null)
            return
          }
          setPointer({ x: PADDING.left, y: 8 })
          setHoverIndex((current) => {
            if (event.key === 'Home') return 0
            if (event.key === 'End') return buckets.length - 1
            return Math.max(
              0,
              Math.min(
                buckets.length - 1,
                (current ?? 0) + (event.key === 'ArrowRight' ? 1 : -1),
              ),
            )
          })
        }}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          style={{ display: 'block' }}
        />

        {hoveredBucket && (
          <Paper
            elevation={4}
            onMouseMove={(event) => event.stopPropagation()}
            sx={{
              position: 'absolute',
              top: Math.min(
                Math.max(pointer.y - 12, 4),
                Math.max(height - 120, 4),
              ),
              left: 8,
              right: 8,
              px: 1.2,
              py: 0.8,
              pointerEvents: 'auto',
              maxWidth: 400,
              maxHeight: 'min(60vh, 420px)',
              overflowY: 'auto',
              userSelect: 'text',
              zIndex: 2,
            }}
          >
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              {dayjs(hoveredBucket.ts).format(
                granularity === 'hour' ? 'MM-DD HH:mm' : 'YYYY-MM-DD',
              )}
            </Typography>
            <Typography
              variant="caption"
              sx={{ display: 'block', fontWeight: 600 }}
            >
              {hoveredBucket.observed === false
                ? t('trafficStats.chart.notObserved')
                : `${t('trafficStats.chart.total')}: ${formatBytes((hoveredValues ?? []).reduce((sum, value) => sum + value, 0))}`}
            </Typography>
            {tooltipRows.map((row) => (
              <Box
                key={row.key}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.8,
                  mt: 0.3,
                }}
              >
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '2px',
                    flexShrink: 0,
                    bgcolor: colorOf(row.key),
                  }}
                />
                <Typography
                  variant="caption"
                  sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
                >
                  {labelOf(row.key)}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatBytes(row.value)}
                </Typography>
              </Box>
            ))}
          </Paper>
        )}
      </Box>
      <Box
        aria-label={t('trafficStats.chart.legend')}
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 1,
          mt: 1,
          userSelect: 'text',
        }}
      >
        {orderedKeys.map((key) => (
          <Box
            key={key}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              maxWidth: '100%',
            }}
          >
            <Box
              sx={{
                width: 9,
                height: 9,
                flexShrink: 0,
                bgcolor: colorOf(key),
                borderRadius: '2px',
              }}
            />
            <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>
              {labelOf(key)}
            </Typography>
          </Box>
        ))}
        {buckets.some((bucket) => bucket.observed === false) && (
          <Typography variant="caption" color="text.secondary">
            ▧ {t('trafficStats.chart.notObserved')}
          </Typography>
        )}
      </Box>
      <Box
        aria-live="polite"
        sx={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clipPath: 'inset(50%)',
        }}
      >
        {bucketSummary}
      </Box>
    </Box>
  )
}
