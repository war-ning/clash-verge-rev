use std::sync::OnceLock;

use anyhow::{Result, anyhow};
use chrono::{DateTime, Utc};
use clash_verge_traffic::{Connection, Identity, Observation, Worker};
pub use clash_verge_traffic::{Query, Snapshot};

use crate::{
    core::{CoreManager, handle::Handle},
    process::AsyncHandler,
    utils::dirs,
};

static WORKER: OnceLock<Worker> = OnceLock::new();
static START_ERROR: OnceLock<String> = OnceLock::new();

fn worker() -> Result<&'static Worker> {
    WORKER.get().ok_or_else(|| {
        anyhow!(
            START_ERROR
                .get()
                .map_or("Statistics are starting; retry shortly", String::as_str)
        )
    })
}

pub fn start() {
    AsyncHandler::spawn(|| async {
        let initialized = tokio::task::spawn_blocking(|| {
            Worker::open(
                dirs::app_home_dir()?.join("traffic-statistics/v2/usage.sqlite3"),
                clash_verge_traffic::system_timezone()?,
            )
        })
        .await;
        let owner = match initialized {
            Ok(Ok(owner)) => owner,
            error => {
                let message = format!("Statistics could not start; existing files were preserved: {error:?}");
                log::error!("{message}");
                let _ = START_ERROR.set(message);
                return;
            }
        };
        if WORKER.set(owner.clone()).is_err() {
            return;
        }
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(1));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            if Handle::global().is_exiting() {
                break;
            }
            let epoch = CoreManager::global().current_core_readiness_generation();
            let observation = if epoch.is_some() {
                match tokio::time::timeout(std::time::Duration::from_secs(3), Handle::mihomo().get_connections()).await
                {
                    Ok(Ok(snapshot)) if epoch == CoreManager::global().current_core_readiness_generation() => {
                        let connections = snapshot.connections.unwrap_or_default();
                        if connections.len() > 10_000 {
                            None
                        } else {
                            Some(Observation {
                                at: Utc::now().timestamp_millis(),
                                epoch: epoch.unwrap_or_default(),
                                connections: connections
                                    .into_iter()
                                    .map(|connection| {
                                        let metadata = connection.metadata;
                                        let host = metadata.host.trim().trim_end_matches('.').to_ascii_lowercase();
                                        let route = match connection.chains.first().map(String::as_str) {
                                            Some("DIRECT") => "direct",
                                            None | Some("REJECT" | "REJECT-DROP" | "PASS" | "COMPATIBLE") => "unknown",
                                            Some(_) => "proxy",
                                        };
                                        Connection {
                                            id: connection.id.to_string(),
                                            start: DateTime::parse_from_rfc3339(&connection.start)
                                                .map_or(i64::MIN, |date| date.timestamp_millis()),
                                            upload: connection.upload,
                                            download: connection.download,
                                            identity: Identity {
                                                target: if host.is_empty() {
                                                    metadata.destination_ip.clone()
                                                } else {
                                                    host
                                                },
                                                ip: metadata.destination_ip,
                                                process: metadata.process,
                                                path: metadata.process_path,
                                                rule: connection.rule,
                                                rule_payload: connection.rule_payload,
                                                chain: connection.chains.join(" → "),
                                                route: route.into(),
                                            },
                                        }
                                    })
                                    .collect(),
                            })
                        }
                    }
                    _ => None,
                }
            } else {
                None
            };
            if owner.observe(observation, Utc::now().timestamp_millis()).await.is_err() {
                break;
            }
        }
        if let Err(error) = owner.flush(Utc::now().timestamp_millis()).await {
            log::error!("Statistics flush failed: {error:#}");
        }
    });
}

pub async fn read(query: Query) -> Result<Snapshot> {
    worker()?.read(query, Utc::now().timestamp_millis()).await
}
pub async fn clear() -> Result<()> {
    worker()?.clear(Utc::now().timestamp_millis()).await
}
pub async fn backup(path: std::path::PathBuf) -> Result<()> {
    if let Some(owner) = WORKER.get() {
        owner.backup(path, Utc::now().timestamp_millis()).await?;
    } else if dirs::app_home_dir()?
        .join("traffic-statistics/v2/usage.sqlite3")
        .exists()
    {
        return Err(anyhow!("Statistics must be available before an update backup"));
    }
    Ok(())
}
pub async fn export(query: Query, path: std::path::PathBuf) -> Result<()> {
    worker()?.export(query, path, Utc::now().timestamp_millis()).await
}
pub async fn flush() -> Result<()> {
    if let Some(owner) = WORKER.get() {
        owner.flush(Utc::now().timestamp_millis()).await?;
    }
    Ok(())
}
