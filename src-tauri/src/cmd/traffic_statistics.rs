use super::{CmdResult, CommandFailure};
use crate::traffic_statistics::{self, Query, Snapshot};

#[tauri::command]
#[specta::specta]
pub async fn read_traffic_statistics(query: Query) -> CmdResult<Snapshot> {
    traffic_statistics::read(query).await.map_err(CommandFailure::plain)
}

#[tauri::command]
#[specta::specta]
pub async fn clear_traffic_statistics() -> CmdResult {
    traffic_statistics::clear().await.map_err(CommandFailure::plain)
}

#[tauri::command]
#[specta::specta]
pub async fn export_traffic_statistics(query: Query, path: String) -> CmdResult {
    traffic_statistics::export(query, path.into())
        .await
        .map_err(CommandFailure::plain)
}
