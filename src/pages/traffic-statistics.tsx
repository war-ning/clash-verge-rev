import { StatisticsPage } from '@/components/traffic-statistics/page'
import { statisticsApi } from '@/services/traffic-statistics/api'

export default function TrafficStatisticsPage() {
  return <StatisticsPage api={statisticsApi} />
}
