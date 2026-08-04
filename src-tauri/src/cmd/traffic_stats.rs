use super::CmdResult;
use crate::{
    cmd::StringifyErr as _,
    module::traffic_stats::{ExportLabels, TrafficStatsManager, TrafficStatsQuery, TrafficStatsResult},
};

/// 查询历史流量统计
#[tauri::command]
pub async fn get_traffic_stats(query: TrafficStatsQuery) -> CmdResult<TrafficStatsResult> {
    TrafficStatsManager::global().query(&query).await.stringify_err()
}

/// 把历史流量统计导出成 xlsx
#[tauri::command]
pub async fn export_traffic_stats(
    query: TrafficStatsQuery,
    path: std::string::String,
    labels: ExportLabels,
) -> CmdResult<()> {
    TrafficStatsManager::global()
        .export(&query, &path, &labels)
        .await
        .stringify_err()
}

/// 清空全部历史流量统计
#[tauri::command]
pub async fn clear_traffic_stats() -> CmdResult<()> {
    TrafficStatsManager::global().clear().await.stringify_err()
}
