use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SerialConfig {
    port: String,
    baud_rate: u32,
    data_bits: u8,
    stop_bits: String,
    parity: String,
    flow_control: String,
    dtr: bool,
    rts: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortInfo {
    id: String,
    path: String,
    device_key: String,
    friendly_name: String,
    alias: Option<String>,
    preferred: bool,
    status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialStatusEvent {
    connected: bool,
    port: Option<String>,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiError {
    code: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenResult {
    connected: bool,
    port: String,
}

struct AppSerialState {
    port: Mutex<Option<Box<dyn SerialPort + Send>>>,
    opened_port: Mutex<Option<String>>,
    recent_configs: Mutex<Vec<SerialConfig>>,
    stats: Mutex<IoStats>,
    device_profiles: Mutex<Vec<DeviceProfile>>,
}

impl Default for AppSerialState {
    fn default() -> Self {
        Self {
            port: Mutex::new(None),
            opened_port: Mutex::new(None),
            recent_configs: Mutex::new(Vec::new()),
            stats: Mutex::new(IoStats::default()),
            device_profiles: Mutex::new(Vec::new()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DeviceProfile {
    device_key: String,
    alias: Option<String>,
    preferred_port: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct IoStats {
    tx_bytes: u64,
    rx_bytes: u64,
    tx_frames: u64,
    rx_frames: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RxChunk {
    bytes: Vec<u8>,
    timestamp_ms: u128,
    stats: IoStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SerialConfigCacheEntry {
    baud_rate: u32,
    data_bits: u8,
    stop_bits: String,
    parity: String,
    flow_control: String,
    dtr: bool,
    rts: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SerialConfigCacheFile {
    last_opened: Option<SerialConfig>,
    by_port: HashMap<String, SerialConfigCacheEntry>,
}

type ApiResult<T> = Result<T, ApiError>;

fn api_err(code: &str, message: impl Into<String>) -> ApiError {
    ApiError {
        code: code.to_string(),
        message: message.into(),
    }
}

fn to_data_bits(v: u8) -> ApiResult<DataBits> {
    match v {
        5 => Ok(DataBits::Five),
        6 => Ok(DataBits::Six),
        7 => Ok(DataBits::Seven),
        8 => Ok(DataBits::Eight),
        _ => Err(api_err("INVALID_CONFIG", "dataBits 仅支持 5/6/7/8")),
    }
}

fn to_stop_bits(v: &str) -> ApiResult<StopBits> {
    match v {
        "1" => Ok(StopBits::One),
        "2" => Ok(StopBits::Two),
        // serialport crate 不支持 1.5，先兼容映射为 1
        "1.5" => Ok(StopBits::One),
        _ => Err(api_err("INVALID_CONFIG", "stopBits 仅支持 1/1.5/2")),
    }
}

fn to_parity(v: &str) -> ApiResult<Parity> {
    match v.to_lowercase().as_str() {
        "none" => Ok(Parity::None),
        "odd" => Ok(Parity::Odd),
        "even" => Ok(Parity::Even),
        _ => Err(api_err("INVALID_CONFIG", "parity 仅支持 None/Odd/Even")),
    }
}

fn to_flow_control(v: &str) -> ApiResult<FlowControl> {
    match v.to_lowercase().as_str() {
        "none" => Ok(FlowControl::None),
        "rts/cts" | "rtscts" => Ok(FlowControl::Hardware),
        "xon/xoff" | "xonxoff" => Ok(FlowControl::Software),
        _ => Err(api_err(
            "INVALID_CONFIG",
            "flowControl 仅支持 None/RTS-CTS/XON-XOFF",
        )),
    }
}

fn validate_config_inner(config: &SerialConfig) -> ApiResult<()> {
    if config.port.trim().is_empty() {
        return Err(api_err("INVALID_CONFIG", "port 不能为空"));
    }
    if config.baud_rate == 0 {
        return Err(api_err("INVALID_CONFIG", "baudRate 必须大于 0"));
    }
    let _ = to_data_bits(config.data_bits)?;
    let _ = to_stop_bits(&config.stop_bits)?;
    let _ = to_parity(&config.parity)?;
    let _ = to_flow_control(&config.flow_control)?;
    Ok(())
}

fn emit_status(app: &AppHandle, evt: SerialStatusEvent) {
    let _ = app.emit("serial://status", evt);
}

fn config_file_path(app: &AppHandle) -> ApiResult<PathBuf> {
    let mut base = app
        .path()
        .app_data_dir()
        .map_err(|e| api_err("CONFIG_PATH_FAILED", e.to_string()))?;
    base.push("uart_tools");
    fs::create_dir_all(&base).map_err(|e| api_err("CONFIG_DIR_FAILED", e.to_string()))?;
    base.push("device_profiles.json");
    Ok(base)
}

fn serial_config_cache_file_path(app: &AppHandle) -> ApiResult<PathBuf> {
    let mut base = app
        .path()
        .app_data_dir()
        .map_err(|e| api_err("CONFIG_PATH_FAILED", e.to_string()))?;
    base.push("uart_tools");
    fs::create_dir_all(&base).map_err(|e| api_err("CONFIG_DIR_FAILED", e.to_string()))?;
    base.push("serial_config_cache.json");
    Ok(base)
}

fn load_profiles_from_disk(app: &AppHandle) -> ApiResult<Vec<DeviceProfile>> {
    let path = config_file_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|e| api_err("CONFIG_READ_FAILED", e.to_string()))?;
    let parsed = serde_json::from_str::<Vec<DeviceProfile>>(&text)
        .map_err(|e| api_err("CONFIG_PARSE_FAILED", e.to_string()))?;
    Ok(parsed)
}

fn save_profiles_to_disk(app: &AppHandle, profiles: &[DeviceProfile]) -> ApiResult<()> {
    let path = config_file_path(app)?;
    let text =
        serde_json::to_string_pretty(profiles).map_err(|e| api_err("CONFIG_SERIALIZE_FAILED", e.to_string()))?;
    fs::write(path, text).map_err(|e| api_err("CONFIG_WRITE_FAILED", e.to_string()))?;
    Ok(())
}

fn load_serial_config_cache_from_disk(app: &AppHandle) -> ApiResult<SerialConfigCacheFile> {
    let path = serial_config_cache_file_path(app)?;
    if !path.exists() {
        return Ok(SerialConfigCacheFile::default());
    }
    let text = fs::read_to_string(path).map_err(|e| api_err("CONFIG_READ_FAILED", e.to_string()))?;
    let parsed = serde_json::from_str::<SerialConfigCacheFile>(&text)
        .map_err(|e| api_err("CONFIG_PARSE_FAILED", e.to_string()))?;
    Ok(parsed)
}

fn save_serial_config_cache_to_disk(app: &AppHandle, cache: &SerialConfigCacheFile) -> ApiResult<()> {
    let path = serial_config_cache_file_path(app)?;
    let text =
        serde_json::to_string_pretty(cache).map_err(|e| api_err("CONFIG_SERIALIZE_FAILED", e.to_string()))?;
    fs::write(path, text).map_err(|e| api_err("CONFIG_WRITE_FAILED", e.to_string()))?;
    Ok(())
}

fn build_device_key(port: &serialport::SerialPortInfo) -> String {
    match &port.port_type {
        serialport::SerialPortType::UsbPort(info) => {
            let serial = info.serial_number.clone().unwrap_or_default();
            let pid = format!("{:04X}", info.pid);
            let vid = format!("{:04X}", info.vid);
            format!("usb:{vid}:{pid}:{serial}")
        }
        _ => format!("path:{}", port.port_name),
    }
}

fn append_newline(mut payload: Vec<u8>, newline: &str) -> Vec<u8> {
    match newline.to_uppercase().as_str() {
        "CRLF" => payload.extend_from_slice(b"\r\n"),
        "LF" => payload.push(b'\n'),
        "CR" => payload.push(b'\r'),
        _ => {}
    };
    payload
}

fn parse_hex_payload(text: &str) -> ApiResult<Vec<u8>> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return Err(api_err("INVALID_HEX", "HEX 输入不能为空"));
    }
    if compact.len() % 2 != 0 {
        return Err(api_err("INVALID_HEX", "HEX 必须是偶数字符长度"));
    }
    let mut out = Vec::new();
    for i in (0..compact.len()).step_by(2) {
        let byte = u8::from_str_radix(&compact[i..i + 2], 16)
            .map_err(|_| api_err("INVALID_HEX", "HEX 内容包含非法字符"))?;
        out.push(byte);
    }
    Ok(out)
}

#[tauri::command]
fn serial_scan_ports(app: AppHandle) -> ApiResult<Vec<PortInfo>> {
    let ports = serialport::available_ports().map_err(|e| api_err("SERIAL_SCAN_FAILED", e.to_string()))?;
    let profiles = load_profiles_from_disk(&app)?;
    let mut out = Vec::new();
    for p in ports {
        let device_key = build_device_key(&p);
        let friendly = match p.port_type {
            serialport::SerialPortType::UsbPort(info) => {
                let product = info.product.unwrap_or_else(|| "USB Serial".to_string());
                let manufacturer = info.manufacturer.unwrap_or_default();
                if manufacturer.is_empty() {
                    product
                } else {
                    format!("{manufacturer} {product}")
                }
            }
            _ => p.port_name.clone(),
        };
        let profile = profiles.iter().find(|x| x.device_key == device_key);
        let alias = profile.and_then(|x| x.alias.clone());
        let preferred = profile
            .and_then(|x| x.preferred_port.as_ref())
            .map(|v| v == &p.port_name)
            .unwrap_or(false);
        out.push(PortInfo {
            id: p.port_name.clone(),
            path: p.port_name.clone(),
            device_key,
            friendly_name: friendly,
            alias,
            preferred,
            status: "idle".to_string(),
        });
    }
    let _ = app.emit("serial://ports", &out);
    Ok(out)
}

#[tauri::command]
fn serial_validate_config(config: SerialConfig) -> ApiResult<bool> {
    validate_config_inner(&config)?;
    Ok(true)
}

#[tauri::command]
fn serial_open(app: AppHandle, state: State<AppSerialState>, config: SerialConfig) -> ApiResult<OpenResult> {
    validate_config_inner(&config)?;

    let builder = serialport::new(&config.port, config.baud_rate)
        .data_bits(to_data_bits(config.data_bits)?)
        .stop_bits(to_stop_bits(&config.stop_bits)?)
        .parity(to_parity(&config.parity)?)
        .flow_control(to_flow_control(&config.flow_control)?)
        .timeout(Duration::from_millis(100));

    let mut opened = builder
        .open()
        .map_err(|e| api_err("SERIAL_OPEN_FAILED", format!("打开串口失败: {e}")))?;

    let _ = opened.write_data_terminal_ready(config.dtr);
    let _ = opened.write_request_to_send(config.rts);

    {
        let mut holder = state
            .port
            .lock()
            .map_err(|_| api_err("STATE_LOCK_FAILED", "串口状态锁失败"))?;
        *holder = Some(opened);
    }
    {
        let mut opened_port = state
            .opened_port
            .lock()
            .map_err(|_| api_err("STATE_LOCK_FAILED", "串口状态锁失败"))?;
        *opened_port = Some(config.port.clone());
    }
    {
        let mut recent = state
            .recent_configs
            .lock()
            .map_err(|_| api_err("STATE_LOCK_FAILED", "最近配置状态锁失败"))?;
        recent.retain(|x| {
            !(x.port == config.port
                && x.baud_rate == config.baud_rate
                && x.data_bits == config.data_bits
                && x.stop_bits == config.stop_bits
                && x.parity == config.parity
                && x.flow_control == config.flow_control
                && x.dtr == config.dtr
                && x.rts == config.rts)
        });
        recent.insert(0, config.clone());
        if recent.len() > 3 {
            recent.truncate(3);
        }
    }

    emit_status(
        &app,
        SerialStatusEvent {
            connected: true,
            port: Some(config.port.clone()),
            message: "串口已打开".to_string(),
        },
    );

    Ok(OpenResult {
        connected: true,
        port: config.port,
    })
}

#[tauri::command]
fn serial_close(app: AppHandle, state: State<AppSerialState>) -> ApiResult<bool> {
    {
        let mut holder = state
            .port
            .lock()
            .map_err(|_| api_err("STATE_LOCK_FAILED", "串口状态锁失败"))?;
        *holder = None;
    }
    {
        let mut opened_port = state
            .opened_port
            .lock()
            .map_err(|_| api_err("STATE_LOCK_FAILED", "串口状态锁失败"))?;
        *opened_port = None;
    }
    {
        let mut stats = state
            .stats
            .lock()
            .map_err(|_| api_err("STATE_LOCK_FAILED", "统计状态锁失败"))?;
        *stats = IoStats::default();
    }
    emit_status(
        &app,
        SerialStatusEvent {
            connected: false,
            port: None,
            message: "串口已关闭".to_string(),
        },
    );
    Ok(true)
}

#[tauri::command]
fn serial_set_line_state(state: State<AppSerialState>, dtr: bool, rts: bool) -> ApiResult<bool> {
    let mut holder = state
        .port
        .lock()
        .map_err(|_| api_err("STATE_LOCK_FAILED", "串口状态锁失败"))?;
    let port = holder
        .as_mut()
        .ok_or_else(|| api_err("SERIAL_NOT_OPEN", "串口未打开"))?;
    port.write_data_terminal_ready(dtr)
        .map_err(|e| api_err("SERIAL_LINE_STATE_FAILED", e.to_string()))?;
    port.write_request_to_send(rts)
        .map_err(|e| api_err("SERIAL_LINE_STATE_FAILED", e.to_string()))?;
    Ok(true)
}

#[tauri::command]
fn serial_get_recent_configs(state: State<AppSerialState>) -> ApiResult<Vec<SerialConfig>> {
    let recent = state
        .recent_configs
        .lock()
        .map_err(|_| api_err("STATE_LOCK_FAILED", "最近配置状态锁失败"))?;
    Ok(recent.clone())
}

#[tauri::command]
fn serial_get_config_cache(app: AppHandle) -> ApiResult<SerialConfigCacheFile> {
    load_serial_config_cache_from_disk(&app)
}

#[tauri::command]
fn serial_save_config_cache(app: AppHandle, cache: SerialConfigCacheFile) -> ApiResult<bool> {
    save_serial_config_cache_to_disk(&app, &cache)?;
    Ok(true)
}

#[tauri::command]
fn serial_get_device_profiles(app: AppHandle) -> ApiResult<Vec<DeviceProfile>> {
    load_profiles_from_disk(&app)
}

#[tauri::command]
fn serial_set_device_profile(
    app: AppHandle,
    state: State<AppSerialState>,
    device_key: String,
    alias: Option<String>,
    preferred_port: Option<String>,
) -> ApiResult<bool> {
    let mut profiles = state
        .device_profiles
        .lock()
        .map_err(|_| api_err("STATE_LOCK_FAILED", "设备配置状态锁失败"))?;

    if profiles.is_empty() {
        *profiles = load_profiles_from_disk(&app)?;
    }

    let alias = alias.map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
    let preferred_port = preferred_port
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty());

    if let Some(p) = profiles.iter_mut().find(|x| x.device_key == device_key) {
        p.alias = alias;
        p.preferred_port = preferred_port;
    } else {
        profiles.push(DeviceProfile {
            device_key,
            alias,
            preferred_port,
        });
    }

    save_profiles_to_disk(&app, &profiles)?;
    Ok(true)
}

#[tauri::command]
fn serial_send_ascii(
    state: State<AppSerialState>,
    payload: String,
    newline_mode: String,
) -> ApiResult<IoStats> {
    let mut holder = state
        .port
        .lock()
        .map_err(|_| api_err("STATE_LOCK_FAILED", "串口状态锁失败"))?;
    let port = holder
        .as_mut()
        .ok_or_else(|| api_err("SERIAL_NOT_OPEN", "串口未打开"))?;

    let data = append_newline(payload.into_bytes(), &newline_mode);
    port.write_all(&data)
        .map_err(|e| api_err("SERIAL_SEND_FAILED", e.to_string()))?;

    let mut stats = state
        .stats
        .lock()
        .map_err(|_| api_err("STATE_LOCK_FAILED", "统计状态锁失败"))?;
    stats.tx_bytes += data.len() as u64;
    stats.tx_frames += 1;
    Ok(stats.clone())
}

#[tauri::command]
fn serial_send_hex(state: State<AppSerialState>, payload: String, newline_mode: String) -> ApiResult<IoStats> {
    let mut holder = state
        .port
        .lock()
        .map_err(|_| api_err("STATE_LOCK_FAILED", "串口状态锁失败"))?;
    let port = holder
        .as_mut()
        .ok_or_else(|| api_err("SERIAL_NOT_OPEN", "串口未打开"))?;

    let bytes = parse_hex_payload(&payload)?;
    let data = append_newline(bytes, &newline_mode);
    port.write_all(&data)
        .map_err(|e| api_err("SERIAL_SEND_FAILED", e.to_string()))?;

    let mut stats = state
        .stats
        .lock()
        .map_err(|_| api_err("STATE_LOCK_FAILED", "统计状态锁失败"))?;
    stats.tx_bytes += data.len() as u64;
    stats.tx_frames += 1;
    Ok(stats.clone())
}

#[tauri::command]
fn serial_read_available(state: State<AppSerialState>) -> ApiResult<RxChunk> {
    let mut holder = state
        .port
        .lock()
        .map_err(|_| api_err("STATE_LOCK_FAILED", "串口状态锁失败"))?;
    let port = holder
        .as_mut()
        .ok_or_else(|| api_err("SERIAL_NOT_OPEN", "串口未打开"))?;

    let mut bytes = Vec::new();
    loop {
        let pending = port
            .bytes_to_read()
            .map_err(|e| api_err("SERIAL_READ_FAILED", e.to_string()))?;
        if pending == 0 {
            break;
        }
        let mut buf = vec![0u8; pending.min(1024) as usize];
        let read = port
            .read(&mut buf)
            .map_err(|e| api_err("SERIAL_READ_FAILED", e.to_string()))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..read]);
    }

    let mut stats = state
        .stats
        .lock()
        .map_err(|_| api_err("STATE_LOCK_FAILED", "统计状态锁失败"))?;
    if !bytes.is_empty() {
        stats.rx_bytes += bytes.len() as u64;
        stats.rx_frames += 1;
    }
    Ok(RxChunk {
        bytes,
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| api_err("TIME_FAILED", "获取时间戳失败"))?
            .as_millis(),
        stats: stats.clone(),
    })
}

#[tauri::command]
fn serial_get_stats(state: State<AppSerialState>) -> ApiResult<IoStats> {
    let stats = state
        .stats
        .lock()
        .map_err(|_| api_err("STATE_LOCK_FAILED", "统计状态锁失败"))?;
    Ok(stats.clone())
}

#[tauri::command]
fn serial_reset_stats(state: State<AppSerialState>) -> ApiResult<IoStats> {
    let mut stats = state
        .stats
        .lock()
        .map_err(|_| api_err("STATE_LOCK_FAILED", "统计状态锁失败"))?;
    *stats = IoStats::default();
    Ok(stats.clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppSerialState::default())
        .invoke_handler(tauri::generate_handler![
            serial_scan_ports,
            serial_validate_config,
            serial_open,
            serial_close,
            serial_set_line_state,
            serial_get_recent_configs,
            serial_get_config_cache,
            serial_save_config_cache,
            serial_send_ascii,
            serial_send_hex,
            serial_read_available,
            serial_get_stats,
            serial_reset_stats,
            serial_get_device_profiles,
            serial_set_device_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
