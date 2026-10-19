use super::{CmdResult, CommandFailure};
use crate::traffic_statistics::{self, Settings, Snapshot};

#[tauri::command]
pub async fn read_traffic_statistics(start: i64, end: i64) -> CmdResult<Snapshot> {
    traffic_statistics::read(start, end)
        .await
        .map_err(CommandFailure::plain)
}

#[tauri::command]
pub async fn configure_traffic_statistics(settings: Settings) -> CmdResult {
    traffic_statistics::configure(settings)
        .await
        .map_err(CommandFailure::plain)
}

#[tauri::command]
pub async fn clear_traffic_statistics() -> CmdResult {
    traffic_statistics::clear().await.map_err(CommandFailure::plain)
}
