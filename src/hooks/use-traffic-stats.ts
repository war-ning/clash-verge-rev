import { getTrafficStats } from '@/services/cmds'
import { useQuery } from '@/services/query-client'

/**
 * 查询历史流量统计。
 *
 * 数据由后端常驻采集器落盘，与窗口是否可见无关，因此这里不接可见性门控；
 * 但也不做轮询——统计是历史数据，用户主动切换范围/刷新时再拉即可。
 */
export const useTrafficStats = (query: ITrafficStatsQuery, enabled = true) => {
  const { data, error, isLoading, isFetching, refetch } =
    useQuery<ITrafficStatsResult>({
      queryKey: [
        'getTrafficStats',
        query.dimension,
        query.granularity,
        query.startMs,
        query.endMs,
        query.topN ?? 0,
        query.groups ?? [],
        query.metric ?? 'total',
        query.search ?? '',
        query.aggregate ?? false,
      ],
      queryFn: () => getTrafficStats(query),
      enabled,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })

  return {
    stats: data,
    loading: isLoading || isFetching,
    error,
    refetch,
  }
}
