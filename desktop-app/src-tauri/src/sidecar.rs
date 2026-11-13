//! MeshAudio Node service lifecycle.
//!
//! The service is launched as a normal child process so the shell can keep the
//! runtime self-contained and use a graceful stop attempt before the hard-kill
//! fallback. Packaging prepares a verified Node runtime and server bundle under
//! `$RESOURCE/resources/meshaudio-runtime/`; development/tests may override it.

use std::{
    collections::HashSet,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const DEFAULT_CONTROL_PORT: u16 = 4173;
const DEFAULT_DISCOVERY_PORT: u16 = 4174;
const DEFAULT_AUDIO_PORT: u16 = 4175;
const MIN_PORT: u16 = 1024;
const MAX_PORT: u16 = 65500;
const DEFAULT_READINESS_TIMEOUT: Duration = Duration::from_secs(15);
const READINESS_INTERVAL: Duration = Duration::from_millis(100);
/// Mirrors `EXIT_ALREADY_RUNNING` in `server.js`: the child saw a live owner.
const EXIT_ALREADY_RUNNING: i32 = 3;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarConfig {
    /// `None` uses the historical default when free; `Some(0)` requests an ephemeral port.
    #[serde(default)]
    pub control_port: Option<u16>,
    #[serde(default)]
    pub discovery_port: Option<u16>,
    #[serde(default)]
    pub audio_port: Option<u16>,
    /// Defaults to Tauri `app_config_dir`.
    #[serde(default)]
    pub data_dir: Option<String>,
    /// Optional resource directory override for development and tests.
    #[serde(default)]
    pub resource_dir: Option<String>,
    /// Defaults to 15 seconds.
    #[serde(default)]
    pub readiness_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    pub state: SidecarState,
    pub pid: Option<u32>,
    pub bind_host: String,
    pub control_port: Option<u16>,
    pub discovery_port: Option<u16>,
    pub audio_port: Option<u16>,
    pub health_url: Option<String>,
    pub data_dir: String,
    pub resource_dir: Option<String>,
    pub last_error: Option<String>,
    pub started_at_ms: Option<u128>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SidecarState {
    Stopped,
    Starting,
    Ready,
    Stopping,
    Failed,
}

impl Default for SidecarStatus {
    fn default() -> Self {
        Self {
            state: SidecarState::Stopped,
            pid: None,
            bind_host: "127.0.0.1".to_owned(),
            control_port: None,
            discovery_port: None,
            audio_port: None,
            health_url: None,
            data_dir: String::new(),
            resource_dir: None,
            last_error: None,
            started_at_ms: None,
        }
    }
}

/// Manifest written by `server.js` into the data directory. It is the single
/// source of truth for which process owns the audio service and on which ports.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeManifest {
    pid: u32,
    control_port: u16,
    #[serde(default)]
    discovery_port: Option<u16>,
    #[serde(default)]
    audio_port: Option<u16>,
}

pub struct SidecarManager {
    inner: Mutex<SidecarInner>,
    // The app starts the backend from setup() and the webview also asks for it
    // when it mounts; only one of those may spawn a process.
    starting: std::sync::atomic::AtomicBool,
}

struct SidecarInner {
    child: Option<Child>,
    /// Set when we adopted a server that this shell did not spawn; we still own
    /// its lifetime so closing the app never leaves an orphan behind.
    adopted_pid: Option<u32>,
    status: SidecarStatus,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SidecarInner {
                child: None,
                adopted_pid: None,
                status: SidecarStatus::default(),
            }),
            starting: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> SidecarStatus {
        self.inner
            .lock()
            .expect("sidecar manager poisoned")
            .status
            .clone()
    }

    pub fn status_with_probe(&self) -> SidecarStatus {
        let mut event = None;
        let mut status = {
            let mut inner = self.inner.lock().expect("sidecar manager poisoned");
            if let Some(child) = inner.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(exit)) => {
                        inner.child = None;
                        inner.status.state = SidecarState::Failed;
                        inner.status.pid = None;
                        inner.status.last_error = Some(format!(
                            "sidecar 已退出，code={:?}",
                            exit.code()
                        ));
                        event = inner.status.last_error.clone();
                    }
                    Ok(None) => {}
                    Err(error) => {
                        inner.status.last_error = Some(format!("检查 sidecar 状态失败: {error}"));
                    }
                }
            }
            inner.status.clone()
        };

        if status.state == SidecarState::Ready {
            if let Some(port) = status.control_port {
                if !health_probe(port) {
                    status.state = SidecarState::Failed;
                    status.last_error = Some("sidecar health endpoint 不可达".to_owned());
                    if let Ok(mut inner) = self.inner.lock() {
                        inner.status = status.clone();
                    }
                    event = status.last_error.clone();
                }
            }
        }
        // Commands do not have an AppHandle, so a probe only updates returned state.
        // The background child monitor emits the corresponding event when possible.
        let _ = event;
        status
    }

    pub fn start(
        self: &Arc<Self>,
        app: &AppHandle,
        requested: SidecarConfig,
    ) -> Result<SidecarStatus, String> {
        use std::sync::atomic::Ordering;
        if self.starting.swap(true, Ordering::SeqCst) {
            // Another caller is already spawning the backend; wait for its
            // result instead of launching a second process.
            for _ in 0..120 {
                std::thread::sleep(std::time::Duration::from_millis(50));
                let status = self.status();
                if status.pid.is_some() || status.state == SidecarState::Failed {
                    return Ok(status);
                }
            }
            return Ok(self.status());
        }
        let result = self.start_locked(app, requested);
        self.starting.store(false, Ordering::SeqCst);
        result
    }

    fn start_locked(
        self: &Arc<Self>,
        app: &AppHandle,
        requested: SidecarConfig,
    ) -> Result<SidecarStatus, String> {
        {
            let mut inner = self.inner.lock().map_err(|_| "sidecar manager poisoned".to_owned())?;
            if let Some(child) = inner.child.as_mut() {
                match child.try_wait() {
                    Ok(None) => return Ok(inner.status.clone()),
                    Ok(Some(exit)) => {
                        inner.child = None;
                        inner.status.state = SidecarState::Failed;
                        inner.status.pid = None;
                        inner.status.last_error = Some(format!(
                            "sidecar 已退出，code={:?}",
                            exit.code()
                        ));
                    }
                    Err(error) => {
                        inner.status.last_error = Some(format!("检查 sidecar 状态失败: {error}"));
                    }
                }
            }
            inner.status = SidecarStatus {
                state: SidecarState::Starting,
                bind_host: "127.0.0.1".to_owned(),
                ..inner.status.clone()
            };
        }
        emit_status(app, self);

        let resource_dir = match resolve_resource_dir(app, requested.resource_dir.as_deref()) {
            Ok(path) => path,
            Err(error) => return Err(fail_start(self, app, error)),
        };
        let data_dir = match resolve_data_dir(app, requested.data_dir.as_deref()) {
            Ok(path) => path,
            Err(error) => return Err(fail_start(self, app, error)),
        };
        // Reuse an already-running MeshAudio server. Spawning a second one
        // would make two engines contend for the same WASAPI output devices,
        // and the newcomer would crash on the busy ports anyway.
        if let Some(status) = adopt_existing(app, self, &data_dir, &resource_dir, &requested) {
            return Ok(status);
        }

        let ports = match choose_ports(&requested) {
            Ok(ports) => ports,
            Err(error) => return Err(fail_start(self, app, error)),
        };
        let (node, server) = match resolve_runtime_files(&resource_dir) {
            Ok(files) => files,
            Err(error) => return Err(fail_start(self, app, error)),
        };

        let mut command = Command::new(spawnable_path(&node));
        command
            .arg(spawnable_path(&server))
            .current_dir(spawnable_path(&resource_dir))
            .env("MESHAUDIO_BIND_HOST", "127.0.0.1")
            .env("MESHAUDIO_CONTROL_BIND_HOST", "127.0.0.1")
            .env("MESHAUDIO_LAN_BIND_HOST", "0.0.0.0")
            .env("MESHAUDIO_NATIVE_AUDIO", "1")
            .env("MESHAUDIO_PORT", ports.control.to_string())
            .env("MESHAUDIO_DISCOVERY_PORT", ports.discovery.to_string())
            .env("MESHAUDIO_AUDIO_PORT", ports.audio.to_string())
            .env("MESHAUDIO_DATA_DIR", &data_dir)
            // The server watches this pid and exits if the shell disappears,
            // so a hard crash can never leave an orphan holding the devices.
            .env("MESHAUDIO_PARENT_PID", std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        suppress_console(&mut command);

        trace(&format!(
            "[spawn] node={} server={} dir={}",
            node.display(),
            server.display(),
            resource_dir.display()
        ));
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return Err(fail_start(
                    self,
                    app,
                    format!("启动 MeshAudio sidecar 失败: {error}"),
                ))
            }
        };
        let pid = child.id();
        drain_output(&mut child, "sidecar");

        {
            let mut inner = self.inner.lock().map_err(|_| "sidecar manager poisoned".to_owned())?;
            inner.child = Some(child);
            inner.status.pid = Some(pid);
            inner.status.control_port = Some(ports.control);
            inner.status.discovery_port = Some(ports.discovery);
            inner.status.audio_port = Some(ports.audio);
            inner.status.health_url = Some(format!(
                "http://127.0.0.1:{}/api/health",
                ports.control
            ));
            inner.status.data_dir = data_dir.display().to_string();
            inner.status.resource_dir = Some(resource_dir.display().to_string());
            inner.status.last_error = None;
            inner.status.started_at_ms = Some(unix_time_ms());
        }
        emit_status(app, self);
        spawn_child_monitor(app.clone(), Arc::clone(self), pid);

        let timeout = Duration::from_millis(
            requested
                .readiness_timeout_ms
                .unwrap_or(DEFAULT_READINESS_TIMEOUT.as_millis() as u64),
        );
        if !wait_ready(ports.control, timeout) {
            // The server exits with this code when it finds a live instance
            // already owning the service — defer to that one instead of
            // reporting a hard failure.
            let deferred = {
                match self.inner.lock() {
                    Ok(mut inner) => inner
                        .child
                        .as_mut()
                        .and_then(|c| c.try_wait().ok().flatten())
                        .and_then(|s| s.code())
                        .map(|code| code == EXIT_ALREADY_RUNNING)
                        .unwrap_or(false),
                    Err(_) => false,
                }
            };
            if deferred {
                trace("[adopt] child deferred to an existing instance; adopting it");
                let _ = self.stop(app);
                if let Some(status) = adopt_existing(app, self, &data_dir, &resource_dir, &requested) {
                    let _ = app.emit("sidecar-ready", status.clone());
                    return Ok(status);
                }
            }
            let error = format!(
                "sidecar 未在 {timeout:?} 内通过 /api/health readiness 检查（端口 {}）",
                ports.control
            );
            let _ = self.stop(app);
            return Err(fail_start(self, app, error));
        }

        {
            let mut inner = self.inner.lock().map_err(|_| "sidecar manager poisoned".to_owned())?;
            inner.status.state = SidecarState::Ready;
        }
        emit_status(app, self);
        let _ = app.emit("sidecar-ready", self.status());
        Ok(self.status())
    }

    pub fn stop(&self, app: &AppHandle) -> Result<SidecarStatus, String> {
        self.stop_inner(app, false)
    }

    pub fn force_stop(&self, app: &AppHandle) -> Result<SidecarStatus, String> {
        self.stop_inner(app, true)
    }

    fn stop_inner(&self, app: &AppHandle, force: bool) -> Result<SidecarStatus, String> {
        let (mut child, adopted_pid, adopted_port) = {
            let mut inner = self.inner.lock().map_err(|_| "sidecar manager poisoned".to_owned())?;
            if inner.child.is_none() && inner.adopted_pid.is_none() {
                inner.status.state = SidecarState::Stopped;
                inner.status.pid = None;
                let status = inner.status.clone();
                drop(inner);
                emit_status(app, self);
                return Ok(status);
            }
            inner.status.state = SidecarState::Stopping;
            inner.status.last_error = None;
            let port = inner.status.control_port;
            (inner.child.take(), inner.adopted_pid.take(), port)
        };
        emit_status(app, self);

        if let Some(pid) = adopted_pid {
            stop_adopted(pid, adopted_port);
        }

        if let Some(ref mut process) = child {
            if force {
                hard_kill(process);
            } else {
                graceful_stop(process);
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    match process.try_wait() {
                        Ok(Some(_)) => break,
                        Ok(None) if Instant::now() < deadline => {
                            thread::sleep(Duration::from_millis(50))
                        }
                        Ok(None) => {
                            hard_kill(process);
                            break;
                        }
                        Err(error) => {
                            hard_kill(process);
                            return Err(format!("关闭 sidecar 失败: {error}"));
                        }
                    }
                }
            }
            let _ = process.wait();
        }

        {
            let mut inner = self.inner.lock().map_err(|_| "sidecar manager poisoned".to_owned())?;
            inner.status.state = SidecarState::Stopped;
            inner.status.pid = None;
        }
        emit_status(app, self);
        Ok(self.status())
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            let port = inner.status.control_port;
            if let Some(pid) = inner.adopted_pid.take() {
                stop_adopted(pid, port);
            }
            if let Some(mut child) = inner.child.take() {
                graceful_stop(&mut child);
                hard_kill(&mut child);
                let _ = child.wait();
            }
        }
    }
}

// ── Service discovery / adoption ────────────────────────────────────────────

fn manifest_path(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime.json")
}

fn read_runtime_manifest(data_dir: &Path) -> Option<RuntimeManifest> {
    let raw = std::fs::read_to_string(manifest_path(data_dir)).ok()?;
    serde_json::from_str::<RuntimeManifest>(&raw).ok()
}

fn remove_manifest(data_dir: &Path) {
    let _ = std::fs::remove_file(manifest_path(data_dir));
}

/// Adopt a live MeshAudio server instead of spawning a competitor.
///
/// Order of evidence:
/// 1. `runtime.json` — authoritative pid + real ports (survives random ports).
/// 2. Default control port — covers instances started before the manifest
///    existed (or whose data dir moved).
///
/// A manifest whose port no longer answers is treated as stale and removed so
/// the next start is clean.
fn adopt_existing(
    app: &AppHandle,
    manager: &Arc<SidecarManager>,
    data_dir: &Path,
    resource_dir: &Path,
    requested: &SidecarConfig,
) -> Option<SidecarStatus> {
    // An explicit port request means the caller wants exactly that endpoint.
    if requested.control_port.is_some() {
        return None;
    }

    let mut found: Option<(u16, Option<u16>, Option<u16>, Option<u32>)> = None;

    if let Some(manifest) = read_runtime_manifest(data_dir) {
        if health_probe(manifest.control_port) {
            found = Some((
                manifest.control_port,
                manifest.discovery_port,
                manifest.audio_port,
                Some(manifest.pid),
            ));
        } else {
            trace(&format!(
                "[adopt] manifest port {} is dead; pruning stale manifest (pid {})",
                manifest.control_port, manifest.pid
            ));
            remove_manifest(data_dir);
        }
    }

    if found.is_none() && health_probe(DEFAULT_CONTROL_PORT) {
        found = Some((
            DEFAULT_CONTROL_PORT,
            Some(DEFAULT_DISCOVERY_PORT),
            Some(DEFAULT_AUDIO_PORT),
            None,
        ));
    }

    let (control, discovery, audio, pid) = found?;
    trace(&format!(
        "[adopt] reusing MeshAudio server on port {control} (pid {:?})",
        pid
    ));

    let status = {
        let mut inner = manager.inner.lock().ok()?;
        inner.child = None;
        // Take ownership: closing the app must not leave this process running.
        inner.adopted_pid = pid;
        inner.status = SidecarStatus {
            state: SidecarState::Ready,
            pid,
            bind_host: "127.0.0.1".to_owned(),
            control_port: Some(control),
            discovery_port: discovery.or(Some(DEFAULT_DISCOVERY_PORT)),
            audio_port: audio.or(Some(DEFAULT_AUDIO_PORT)),
            health_url: Some(format!("http://127.0.0.1:{control}/api/health")),
            data_dir: data_dir.display().to_string(),
            resource_dir: Some(resource_dir.display().to_string()),
            last_error: None,
            started_at_ms: Some(unix_time_ms()),
        };
        inner.status.clone()
    };
    emit_status(app, manager);
    // Take over the watchdog so the adopted server still dies with this shell.
    handoff_to_self(control);
    Some(status)
}

/// Terminate a server we adopted. Guarded by a health probe so a recycled pid
/// can never take down an unrelated process.
fn stop_adopted(pid: u32, control_port: Option<u16>) {
    if let Some(port) = control_port {
        if !health_probe(port) {
            return;
        }
    }
    trace(&format!("[adopt] stopping adopted server pid {pid}"));
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[derive(Debug, Clone, Copy)]
struct Ports {
    control: u16,
    discovery: u16,
    audio: u16,
}

fn choose_ports(config: &SidecarConfig) -> Result<Ports, String> {
    let mut used = HashSet::new();
    let control = choose_port(config.control_port, DEFAULT_CONTROL_PORT, true, &used)?;
    used.insert(control);
    let discovery = choose_port(config.discovery_port, DEFAULT_DISCOVERY_PORT, false, &used)?;
    used.insert(discovery);
    let audio = choose_port(config.audio_port, DEFAULT_AUDIO_PORT, false, &used)?;
    Ok(Ports {
        control,
        discovery,
        audio,
    })
}

fn choose_port(
    requested: Option<u16>,
    default: u16,
    tcp: bool,
    used: &HashSet<u16>,
) -> Result<u16, String> {
    if let Some(port) = requested {
        if port != 0 && !(MIN_PORT..=MAX_PORT).contains(&port) {
            return Err(format!(
                "端口 {port} 不在允许范围 {MIN_PORT}..={MAX_PORT}"
            ));
        }
        if port != 0 {
            if used.contains(&port) || !port_available(port, tcp) {
                return Err(format!("端口 {port} 已被占用"));
            }
            return Ok(port);
        }
    } else if !used.contains(&default) && port_available(default, tcp) {
        return Ok(default);
    }

    let port = if tcp {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("分配 TCP 端口失败: {error}"))?
            .local_addr()
            .map_err(|error| format!("读取 TCP 端口失败: {error}"))?
            .port()
    } else {
        std::net::UdpSocket::bind(("127.0.0.1", 0))
            .map_err(|error| format!("分配 UDP 端口失败: {error}"))?
            .local_addr()
            .map_err(|error| format!("读取 UDP 端口失败: {error}"))?
            .port()
    };
    if used.contains(&port) {
        return Err(format!("分配到重复端口 {port}"));
    }
    Ok(port)
}

fn port_available(port: u16, tcp: bool) -> bool {
    if tcp {
        std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
    } else {
        std::net::UdpSocket::bind(("127.0.0.1", port)).is_ok()
    }
}

fn resolve_resource_dir(app: &AppHandle, override_dir: Option<&str>) -> Result<PathBuf, String> {
    if let Some(path) = override_dir.filter(|value| !value.trim().is_empty()) {
        return Ok(PathBuf::from(path));
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("读取 Tauri resource_dir 失败: {error}"))?;
    let candidates = [
        resource_dir.join("meshaudio-runtime"),
        resource_dir.join("resources").join("meshaudio-runtime"),
        resource_dir.clone(),
    ];
    candidates
        .iter()
        .cloned()
        .find(|path| path.join(if cfg!(windows) { "node.exe" } else { "node" }).exists() && path.join("server.js").exists())
        .ok_or_else(|| format!("未找到 sidecar 资源目录，已检查：{}", candidates.iter().map(|path| path.display().to_string()).collect::<Vec<_>>().join("; ")))
}

fn resolve_data_dir(app: &AppHandle, override_dir: Option<&str>) -> Result<PathBuf, String> {
    let path = override_dir
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| app.path().app_config_dir().ok())
        .ok_or_else(|| "无法解析 app_config_dir".to_owned())?;
    std::fs::create_dir_all(&path).map_err(|error| format!("创建 MESHAUDIO_DATA_DIR 失败: {error}"))?;
    Ok(path)
}

fn resolve_runtime_files(resource_dir: &Path) -> Result<(PathBuf, PathBuf), String> {
    let node = resource_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let server = resource_dir.join("server.js");
    if node.exists() && server.exists() {
        return Ok((node, server));
    }
    Err(format!(
        "运行文件不完整：缺少 {} 或 {}。请重新安装 MeshAudio；从源码构建时请先完成资源准备。",
        node.display(),
        server.display()
    ))
}

/// Tell an adopted server to watch *this* shell instead of its previous owner.
///
/// Without it, a server we adopted from a crashed shell would outlive a
/// hard-killed app (the Drop guard only runs on graceful exits). The server
/// refuses the transfer while its current owner is still alive, so a second
/// window can never orphan the first one's service.
fn handoff_to_self(port: u16) {
    use std::io::{Read, Write};
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(400)) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    let body = format!("{{\"parentPid\":{}}}", std::process::id());
    let request = format!(
        "POST /api/handoff HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return;
    }
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    let status = String::from_utf8_lossy(&response)
        .lines()
        .next()
        .unwrap_or("")
        .to_owned();
    trace(&format!(
        "[adopt] handoff to pid {} -> {}",
        std::process::id(),
        status
    ));
}

fn wait_ready(port: u16, timeout: Duration) -> bool {    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if health_probe(port) {
            return true;
        }
        thread::sleep(READINESS_INTERVAL);
    }
    false
}

fn health_probe(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(200)) else {
        return false;
    };
    use std::io::{Read, Write};
    if stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .is_err()
    {
        return false;
    }
    if stream
        .write_all(
            b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        )
        .is_err()
    {
        return false;
    }
    let mut response = Vec::new();
    if stream.read_to_end(&mut response).is_err() {
        return false;
    }
    let response = String::from_utf8_lossy(&response);
    response.starts_with("HTTP/1.1 200") && response.contains("\"ok\":true")
}

fn graceful_stop(child: &mut Child) {
    let pid = child.id().to_string();
    #[cfg(windows)]
    {
        // Node's SIGTERM handler performs server/socket cleanup. `taskkill` without
        // /F is the best std-only graceful request; Child::kill is the hard fallback.
        let mut command = Command::new("taskkill");
        command.args(["/PID", pid.as_str(), "/T"]);
        suppress_console(&mut command);
        let _ = command.status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-TERM", &pid]).status();
    }
}

fn hard_kill(child: &mut Child) {
    let _ = child.kill();
}

fn drain_output(child: &mut Child, prefix: &'static str) {
    // The sidecar's own stdout/stderr is the only place its startup errors are
    // visible; without forwarding, a failed bind shows up as an opaque
    // "readiness timeout" in this log.
    if let Some(stdout) = child.stdout.take() {
        thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                trace(&format!("[{prefix}-out] {line}"));
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                trace(&format!("[{prefix}-err] {line}"));
            }
        });
    }
}

fn suppress_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
}

/// Resource paths arrive with the Windows extended-length prefix
/// (`\\?\E:\...`). Node refuses `\\?\` paths as its entry argv (EISDIR on the
/// drive component during module resolution), so strip the prefix before
/// spawning. Network UNC form is converted back to `\\server\share`.
fn spawnable_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.to_string()
    }
}

fn spawn_child_monitor(app: AppHandle, manager: Arc<SidecarManager>, pid: u32) {
    thread::Builder::new()
        .name("meshaudio-sidecar-monitor".to_owned())
        .spawn(move || loop {
            thread::sleep(Duration::from_millis(500));
            let mut event = None;
            let should_stop = {
                let mut inner = match manager.inner.lock() {
                    Ok(inner) => inner,
                    Err(_) => return,
                };
                if inner.status.pid != Some(pid) {
                    true
                } else if let Some(child) = inner.child.as_mut() {
                    match child.try_wait() {
                        Ok(Some(exit)) => {
                            inner.child = None;
                            inner.status.state = SidecarState::Failed;
                            inner.status.pid = None;
                            inner.status.last_error = Some(format!(
                                "sidecar 已退出，code={:?}",
                                exit.code()
                            ));
                            event = inner.status.last_error.clone();
                            true
                        }
                        Ok(None) => false,
                        Err(error) => {
                            inner.child = None;
                            inner.status.state = SidecarState::Failed;
                            inner.status.pid = None;
                            inner.status.last_error = Some(format!("监视 sidecar 失败: {error}"));
                            event = inner.status.last_error.clone();
                            true
                        }
                    }
                } else {
                    true
                }
            };
            if should_stop {
                emit_status(&app, &manager);
                if let Some(error) = event {
                    let _ = app.emit("sidecar-error", serde_json::json!({ "message": error }));
                }
                return;
            }
        })
        .ok();
}

fn unix_time_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default()
}

// A packaged app has no console, and sidecar startup happens before the UI can
// show anything useful, so keep a small trace next to the app's temp dir.
fn trace(message: &str) {
    let path = std::env::temp_dir().join("meshaudio-sidecar.log");
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(file, "{message}");
    }
}

fn fail_start(manager: &SidecarManager, app: &AppHandle, message: String) -> String {
    trace(&format!("[fail] {message}"));
    if let Ok(mut inner) = manager.inner.lock() {
        inner.child = None;
        inner.status.state = SidecarState::Failed;
        inner.status.pid = None;
        inner.status.last_error = Some(message.clone());
    }
    emit_status(app, manager);
    let _ = app.emit(
        "sidecar-error",
        serde_json::json!({ "message": message.clone() }),
    );
    message
}

fn emit_status(app: &AppHandle, manager: &SidecarManager) {
    let _ = app.emit("sidecar-status-changed", manager.status());
}

#[tauri::command]
pub fn start_sidecar(
    app: AppHandle,
    manager: State<'_, Arc<SidecarManager>>,
    config: Option<SidecarConfig>,
) -> Result<SidecarStatus, String> {
    trace("[invoke] start_sidecar");
    Arc::clone(manager.inner()).start(&app, config.unwrap_or_default())
}

#[tauri::command]
pub fn frontend_log(message: String) {
    trace(&format!("[frontend] {message}"));
}

#[tauri::command]
pub fn stop_sidecar(
    app: AppHandle,
    manager: State<'_, Arc<SidecarManager>>,
) -> Result<SidecarStatus, String> {
    manager.stop(&app)
}

#[tauri::command]
pub fn force_stop_sidecar(
    app: AppHandle,
    manager: State<'_, Arc<SidecarManager>>,
) -> Result<SidecarStatus, String> {
    manager.force_stop(&app)
}

#[tauri::command]
pub fn sidecar_status(manager: State<'_, Arc<SidecarManager>>) -> SidecarStatus {
    manager.status_with_probe()
}

#[tauri::command]
pub fn sidecar_health(manager: State<'_, Arc<SidecarManager>>) -> bool {
    manager
        .status()
        .control_port
        .map(health_probe)
        .unwrap_or(false)
}
