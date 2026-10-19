use crate::{Type, core::handle, logging};
use anyhow::Result;
use serde::Deserialize;
use std::time::Duration;
use tauri_plugin_mihomo::models::ConnectionId;
use tokio::sync::mpsc;
use tokio::time::Instant;

/// Mihomo WebSocket 流的有界队列容量，避免异常场景下内存无限增长。
const MIHOMO_WS_STREAM_BUFFER_SIZE: usize = 8;
/// 断开 Mihomo WebSocket 连接时使用的关闭码（RFC 6455 标准正常关闭）。
const MIHOMO_WS_STREAM_CLOSE_CODE: u64 = 1000;

/// `/traffic` 即时速率事件（字节/秒）。
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy)]
pub struct TrafficSpeedEvent {
    pub up: u64,
    pub down: u64,
}

/// `/connections` 全量快照事件。
///
/// mihomo 约每秒推送一次**当前活动连接的全量列表**，已关闭的连接直接从列表中消失、
/// 不会单独通报。因此消费方只能按连接 id 对累计计数做差分。
#[derive(Debug, Clone)]
pub struct ConnectionsSnapshotEvent {
    /// core 启动以来的全局累计上行字节。
    pub upload_total: u64,
    /// core 启动以来的全局累计下行字节。
    pub download_total: u64,
    /// 当前活动连接。
    pub connections: Vec<ConnectionSample>,
}

/// 单条连接在快照时刻的累计流量与归因信息。
#[derive(Debug, Clone)]
pub struct ConnectionSample {
    /// 连接 id，用于跨快照做差分。
    pub id: String,
    /// 该连接生命周期内的累计上行字节。
    pub upload: u64,
    /// 该连接生命周期内的累计下行字节。
    pub download: u64,
    /// 出口节点（`chains` 首元素，mihomo 按倒序存储）。
    pub node: Option<String>,
    /// 最外层策略组（`chains` 末元素）。
    pub group: Option<String>,
    /// 目标域名，缺失时回落到目标 IP。
    pub host: Option<String>,
    /// 触发该连接的进程名（需 mihomo 开启 find-process-mode，否则为空）。
    pub process: Option<String>,
}

/// Mihomo WebSocket 流消费状态。
pub enum StreamConsumeState<T> {
    /// 收到一条业务事件。
    Event(T),
    /// 连接关闭或消息流结束。
    Closed,
    /// 在超时时间内未收到有效事件，需要重连。
    Stale,
    /// 上层请求退出消费循环。
    ExitRequested,
}

enum InternalWsEvent<T> {
    Data(T),
}

/// Mihomo WebSocket 订阅句柄（通用事件流）。
pub struct MihomoWsEventStream<T> {
    /// 当前订阅连接 ID，用于主动断开。
    pub connection_id: ConnectionId,
    /// 当前订阅消息接收器。
    receiver: mpsc::Receiver<InternalWsEvent<T>>,
    /// 最近一次收到有效事件的时间戳。
    last_valid_event_at: Instant,
}

#[cfg(target_os = "macos")]
#[derive(Deserialize)]
struct TrafficPayload {
    up: u64,
    down: u64,
}

#[cfg(target_os = "macos")]
fn parse_traffic_event(data: &[u8]) -> Option<InternalWsEvent<TrafficSpeedEvent>> {
    let payload = serde_json::from_slice::<TrafficPayload>(data).ok()?;
    Some(InternalWsEvent::Data(TrafficSpeedEvent {
        up: payload.up,
        down: payload.down,
    }))
}

/// `/connections` 原始负载，仅反序列化统计所需字段以降低每秒解析开销。
#[derive(Deserialize)]
struct ConnectionsPayload {
    #[serde(rename = "uploadTotal", default)]
    upload_total: u64,
    #[serde(rename = "downloadTotal", default)]
    download_total: u64,
    /// 无活动连接时 mihomo 会返回 null。
    #[serde(default)]
    connections: Option<Vec<ConnectionPayload>>,
}

#[derive(Deserialize)]
struct ConnectionPayload {
    #[serde(default)]
    id: String,
    #[serde(default)]
    upload: u64,
    #[serde(default)]
    download: u64,
    #[serde(default)]
    chains: Vec<String>,
    #[serde(default)]
    metadata: ConnectionMetadataPayload,
}

#[derive(Deserialize, Default)]
struct ConnectionMetadataPayload {
    #[serde(default)]
    host: String,
    #[serde(rename = "destinationIP", default)]
    destination_ip: String,
    #[serde(rename = "remoteDestination", default)]
    remote_destination: String,
    #[serde(default)]
    process: String,
    #[serde(rename = "processPath", default)]
    process_path: String,
}

/// 空字符串视为字段缺失。
fn non_empty(value: String) -> Option<String> {
    if value.is_empty() { None } else { Some(value) }
}

impl ConnectionPayload {
    fn into_sample(mut self) -> ConnectionSample {
        // chains 为倒序：首元素是真实出口节点，末元素是最外层策略组。
        let node = self.chains.first().cloned().and_then(non_empty);
        let group = self.chains.pop().and_then(non_empty);
        let host = non_empty(self.metadata.host)
            .or_else(|| non_empty(self.metadata.destination_ip))
            .or_else(|| non_empty(self.metadata.remote_destination));

        ConnectionSample {
            id: self.id,
            upload: self.upload,
            download: self.download,
            node,
            group,
            host,
            process: non_empty(self.metadata.process_path).or_else(|| non_empty(self.metadata.process)),
        }
    }
}

fn parse_connections_event(data: &[u8]) -> Option<InternalWsEvent<ConnectionsSnapshotEvent>> {
    let payload = serde_json::from_slice::<ConnectionsPayload>(data).ok()?;
    let connections = payload
        .connections
        .unwrap_or_default()
        .into_iter()
        .map(ConnectionPayload::into_sample)
        .collect();

    Some(InternalWsEvent::Data(ConnectionsSnapshotEvent {
        upload_total: payload.upload_total,
        download_total: payload.download_total,
        connections,
    }))
}

fn try_send_internal_event<T>(message_tx: &mpsc::Sender<InternalWsEvent<T>>, event: InternalWsEvent<T>) {
    if let Err(err) = message_tx.try_send(event) {
        match err {
            // 队列满时丢弃本次事件，下一次事件会继续覆盖更新。
            tokio::sync::mpsc::error::TrySendError::Full(_) => {}
            // 任务已结束时通道可能关闭，忽略即可。
            tokio::sync::mpsc::error::TrySendError::Closed(_) => {}
        }
    }
}

/// 建立 `/traffic` WebSocket 订阅（通用流）。
#[cfg(target_os = "macos")]
pub async fn connect_traffic_stream() -> Result<MihomoWsEventStream<TrafficSpeedEvent>> {
    // 使用有界 mpsc 通道承接回调事件，限制消息积压上限。
    let (message_tx, message_rx) = mpsc::channel::<InternalWsEvent<TrafficSpeedEvent>>(MIHOMO_WS_STREAM_BUFFER_SIZE);
    // 建立 Mihomo `/traffic` WebSocket 订阅。
    let connection_id = handle::Handle::mihomo()
        .await
        .ws_traffic({
            let message_tx = message_tx.clone();
            move |message| {
                if let Some(event) = parse_traffic_event(&message) {
                    try_send_internal_event(&message_tx, event);
                }
            }
        })
        .await?;
    drop(message_tx);
    Ok(MihomoWsEventStream {
        connection_id,
        receiver: message_rx,
        last_valid_event_at: Instant::now(),
    })
}

/// 建立 `/connections` WebSocket 订阅（通用流）。
///
/// 队列满时丢弃快照是安全的：每条快照携带的是**累计**计数，
/// 丢弃一帧只会让下一次差分覆盖更长的时间窗，不会丢失字节数。
pub async fn connect_connections_stream() -> Result<MihomoWsEventStream<ConnectionsSnapshotEvent>> {
    let (message_tx, message_rx) =
        mpsc::channel::<InternalWsEvent<ConnectionsSnapshotEvent>>(MIHOMO_WS_STREAM_BUFFER_SIZE);
    let connection_id = handle::Handle::mihomo()
        .await
        .ws_connections({
            let message_tx = message_tx.clone();
            move |message| {
                if let Some(event) = parse_connections_event(&message) {
                    try_send_internal_event(&message_tx, event);
                }
            }
        })
        .await?;
    drop(message_tx);
    Ok(MihomoWsEventStream {
        connection_id,
        receiver: message_rx,
        last_valid_event_at: Instant::now(),
    })
}

impl<T> MihomoWsEventStream<T> {
    /// 等待下一次可用事件或结束状态。
    ///
    /// # Arguments
    /// * `idle_poll_interval` - 空闲检查间隔
    /// * `stale_timeout` - 无有效事件超时时间
    /// * `should_exit` - 上层退出判定函数
    pub async fn next_event<F>(
        &mut self,
        _idle_poll_interval: Duration, // 签名保留，但内部逻辑已进化为更高效的驱动方式
        stale_timeout: Duration,
        should_exit: F,
    ) -> StreamConsumeState<T>
    where
        F: Fn() -> bool,
    {
        let sleep = tokio::time::sleep(stale_timeout);
        tokio::pin!(sleep);

        loop {
            if should_exit() {
                return StreamConsumeState::ExitRequested;
            }

            tokio::select! {
                maybe_event = self.receiver.recv() => {
                    match maybe_event {
                        Some(InternalWsEvent::Data(event)) => {
                            self.last_valid_event_at = Instant::now();
                            sleep.as_mut().reset(self.last_valid_event_at + stale_timeout);
                            return StreamConsumeState::Event(event);
                        }
                        None => return StreamConsumeState::Closed,
                    }
                }
                _ = &mut sleep => {
                    if self.last_valid_event_at.elapsed() >= stale_timeout {
                        return StreamConsumeState::Stale;
                    }
                    sleep.as_mut().reset(self.last_valid_event_at + stale_timeout);
                }
            }
        }
    }
}

/// 断开指定 Mihomo WebSocket 连接。
///
/// # Arguments
/// * `connection_id` - 目标连接 ID
pub async fn disconnect_connection(connection_id: ConnectionId) {
    if let Err(err) = handle::Handle::mihomo()
        .await
        .disconnect(connection_id, Some(MIHOMO_WS_STREAM_CLOSE_CODE))
        .await
    {
        logging!(debug, Type::Tray, "断开 Mihomo WebSocket 连接失败: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_path_is_preserved_and_used_when_process_name_is_missing() {
        let raw = r#"{"uploadTotal":0,"downloadTotal":0,"connections":[{"id":"a","metadata":{"processPath":"C:\\Apps\\app.exe"}}]}"#;
        let event = parse(raw).expect("valid snapshot");
        assert_eq!(event.connections[0].process.as_deref(), Some(r"C:\Apps\app.exe"));
    }

    fn parse(raw: &str) -> Option<ConnectionsSnapshotEvent> {
        match parse_connections_event(raw.as_bytes()) {
            Some(InternalWsEvent::Data(event)) => Some(event),
            None => None,
        }
    }

    /// mihomo `/connections` 的真实报文形状：chains 倒序，metadata 为 camelCase。
    #[test]
    fn parses_real_payload_shape() {
        let raw = r#"{
            "downloadTotal": 2048,
            "uploadTotal": 1024,
            "connections": [{
                "id": "abc",
                "upload": 11,
                "download": 22,
                "start": "2026-08-03T10:00:00Z",
                "chains": ["HK-01", "Auto", "Proxy"],
                "rule": "DomainSuffix",
                "rulePayload": "example.com",
                "metadata": {
                    "network": "tcp",
                    "type": "HTTP",
                    "host": "example.com",
                    "sourceIP": "127.0.0.1",
                    "sourcePort": "1234",
                    "destinationIP": "1.1.1.1",
                    "destinationPort": "443",
                    "process": "curl"
                }
            }]
        }"#;

        let event = parse(raw).expect("payload should parse");
        assert_eq!(event.upload_total, 1024);
        assert_eq!(event.download_total, 2048);
        assert_eq!(event.connections.len(), 1);

        let conn = event.connections.first().expect("one connection");
        assert_eq!(conn.id, "abc");
        assert_eq!(conn.upload, 11);
        assert_eq!(conn.download, 22);
        // chains[0] 是真实出口节点，chains 末元素是最外层策略组
        assert_eq!(conn.node.as_deref(), Some("HK-01"));
        assert_eq!(conn.group.as_deref(), Some("Proxy"));
        assert_eq!(conn.host.as_deref(), Some("example.com"));
        assert_eq!(conn.process.as_deref(), Some("curl"));
    }

    /// 无活动连接时 mihomo 会把 connections 置为 null。
    #[test]
    fn parses_null_connections() {
        let event = parse(r#"{"downloadTotal":5,"uploadTotal":3,"connections":null}"#).expect("should parse");
        assert_eq!(event.upload_total, 3);
        assert!(event.connections.is_empty());
    }

    /// 单元素 chains（如 DIRECT）时节点与策略组是同一个值。
    #[test]
    fn single_chain_maps_node_and_group_to_same_value() {
        let raw = r#"{"uploadTotal":0,"downloadTotal":0,"connections":[
            {"id":"x","upload":1,"download":1,"chains":["DIRECT"],"metadata":{}}]}"#;
        let event = parse(raw).expect("should parse");
        let conn = event.connections.first().expect("one connection");
        assert_eq!(conn.node.as_deref(), Some("DIRECT"));
        assert_eq!(conn.group.as_deref(), Some("DIRECT"));
    }

    /// chains 为空 / 字段缺失时不应崩，统一降级为 None。
    #[test]
    fn missing_fields_degrade_to_none() {
        let raw = r#"{"uploadTotal":0,"downloadTotal":0,"connections":[
            {"id":"y","upload":0,"download":0,"chains":[],"metadata":{"host":"","process":""}}]}"#;
        let event = parse(raw).expect("should parse");
        let conn = event.connections.first().expect("one connection");
        assert!(conn.node.is_none());
        assert!(conn.group.is_none());
        assert!(conn.host.is_none());
        assert!(conn.process.is_none());
    }

    /// host 为空时按 destinationIP → remoteDestination 顺序回落。
    #[test]
    fn host_falls_back_to_destination() {
        let by_ip = r#"{"uploadTotal":0,"downloadTotal":0,"connections":[
            {"id":"a","upload":0,"download":0,"chains":["N"],
             "metadata":{"host":"","destinationIP":"9.9.9.9","remoteDestination":"fallback.example"}}]}"#;
        let event = parse(by_ip).expect("should parse");
        assert_eq!(
            event.connections.first().and_then(|conn| conn.host.as_deref()),
            Some("9.9.9.9")
        );

        let by_remote = r#"{"uploadTotal":0,"downloadTotal":0,"connections":[
            {"id":"a","upload":0,"download":0,"chains":["N"],
             "metadata":{"host":"","destinationIP":"","remoteDestination":"fallback.example"}}]}"#;
        let event = parse(by_remote).expect("should parse");
        assert_eq!(
            event.connections.first().and_then(|conn| conn.host.as_deref()),
            Some("fallback.example")
        );
    }

    /// 非法报文只返回 None，不能 panic（回调跑在 WS 线程上）。
    #[test]
    fn invalid_payload_returns_none() {
        assert!(parse("not json").is_none());
        assert!(parse(r#"{"uploadTotal":"nope"}"#).is_none());
    }
}
