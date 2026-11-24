use crate::{config::Config, core::handle::Handle, utils::dirs};
use anyhow::{Result, bail};

pub fn updates_configured() -> bool {
    let Ok(release) = serde_json::from_str::<serde_json::Value>(include_str!("../../custom-release.json")) else {
        return false;
    };
    let Some(endpoint) = release["updateEndpoint"].as_str() else {
        return false;
    };
    let Some(public_key) = release["updatePublicKey"].as_str().filter(|key| !key.is_empty()) else {
        return false;
    };
    if release["updateMode"] != "automatic"
        || !endpoint.starts_with("https://github.com/war-ning/clash-verge-rev/releases/")
    {
        return false;
    }
    let plugins = &Handle::app_handle().config().plugins.0;
    plugins.get("updater").is_some_and(|config| {
        config["pubkey"] == public_key
            && config["endpoints"]
                .as_array()
                .is_some_and(|urls| urls.len() == 1 && urls[0] == endpoint)
    })
}

pub async fn prepare_update() -> Result<()> {
    if !updates_configured() {
        bail!("Only the configured custom update channel can install this build");
    }
    let root = dirs::app_home_dir()?;
    let backup = root
        .join("upgrade-backups")
        .join(format!("upgrade-{}", chrono::Utc::now().timestamp_millis()));
    tokio::fs::create_dir_all(&backup).await?;
    let version = tokio::time::timeout(std::time::Duration::from_secs(2), Handle::mihomo().get_version())
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(|value| serde_json::to_value(value).ok());
    {
        let _profiles = crate::config::profiles::PROFILE_WRITE_LOCK.lock().await;
        let _config = Config::lock_config_write().await;
        let mut files = tokio::fs::read_dir(&root).await?;
        while let Some(entry) = files.next_entry().await? {
            let path = entry.path();
            let kind = entry.file_type().await?;
            if kind.is_file()
                && (matches!(
                    path.extension().and_then(|value| value.to_str()),
                    Some("yaml" | "yml" | "json")
                ) || entry.file_name() == ".encryption_key")
            {
                tokio::fs::copy(&path, backup.join(entry.file_name())).await?;
            }
        }
        let profiles = dirs::app_profiles_dir()?;
        if profiles.exists() {
            tokio::fs::create_dir(backup.join("profiles")).await?;
            let mut files = tokio::fs::read_dir(profiles).await?;
            while let Some(entry) = files.next_entry().await? {
                if entry.file_type().await?.is_file() {
                    tokio::fs::copy(entry.path(), backup.join("profiles").join(entry.file_name())).await?;
                }
            }
        }
    }
    crate::traffic_statistics::backup(backup.join("usage.sqlite3")).await?;
    let manifest = serde_json::json!({
        "applicationVersion": env!("CARGO_PKG_VERSION"),
        "core": version,
        "servicePackageVersion": "v2.7.7",
        "statisticsSchema": 2,
        "createdAt": chrono::Utc::now().to_rfc3339(),
    });
    tokio::fs::write(backup.join("manifest.json"), serde_json::to_vec_pretty(&manifest)?).await?;
    Ok(())
}
