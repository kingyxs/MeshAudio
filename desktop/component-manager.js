'use strict';

/**
 * Component manager: downloads, verifies, unpacks and launches installers for
 * optional third-party components (virtual audio device, AirPlay receiver).
 *
 * Boundaries that matter:
 * - Downloadable components are fetched from the publisher on explicit user
 *   action. Bundled native UxPlay is managed by airplay-manager instead.
 * - Nothing is installed silently. Driver installers need an interactive UAC
 *   prompt, so we launch them elevated and let Windows show the dialog.
 * - Every download is written to `<dataDir>/components/downloads` and its
 *   SHA-256 is recorded. If the manifest pins a hash, a mismatch aborts.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');

const REDIRECT_LIMIT = 5;
const IDLE_TIMEOUT_MS = 45000;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function openStream(target, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return reject(new Error('invalid_url'));
    }
    if (parsed.protocol !== 'https:') return reject(new Error('https_required'));
    const client = parsed.protocol === 'http:' ? http : https;
    const request = client.get(parsed, {
      headers: {
        'User-Agent': 'MeshAudio/0.3 (+https://github.com/)',
        Accept: '*/*'
      }
    }, response => {
      const status = Number(response.statusCode) || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= REDIRECT_LIMIT) return reject(new Error('too_many_redirects'));
        let next;
        try {
          next = new URL(response.headers.location, target).toString();
        } catch {
          return reject(new Error('invalid_redirect'));
        }
        return resolve(openStream(next, redirects + 1));
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`http_${status}`));
      }
      resolve({ stream: response, request });
    });
    request.setTimeout(IDLE_TIMEOUT_MS, () => request.destroy(new Error('download_timeout')));
    request.on('error', reject);
  });
}

function createComponentManager(options) {
  const dataDir = path.resolve(options.dataDir);
  const manifestPath = options.manifestPath;
  const detectFn = typeof options.detect === 'function' ? options.detect : () => ({ detected: false, detail: '' });
  const log = typeof options.log === 'function' ? options.log : () => {};

  const componentsDir = ensureDir(path.join(dataDir, 'components'));
  const downloadDir = ensureDir(path.join(componentsDir, 'downloads'));
  const stateFile = path.join(componentsDir, 'state.json');
  const state = readJson(stateFile, { installed: {}, hashes: {} });
  if (!state.installed) state.installed = {};
  if (!state.hashes) state.hashes = {};

  const manifest = readJson(manifestPath, { components: [] });
  const entries = Array.isArray(manifest.components) ? manifest.components : [];
  const progress = new Map();
  const downloads = new Map();
  const operations = new Map();
  // Detection can spawn a process (`where uxplay`), which would block the
  // audio render loop if it ran on every poll. Cache until an explicit rescan
  // or an install/remove invalidates it.
  const detectionCache = new Map();
  const detectionPending = new Map();

  function entryOf(id) {
    return entries.find(item => item && item.id === id) || null;
  }

  function installDirOf(id) {
    return path.join(componentsDir, id);
  }

  function downloadPathOf(entry) {
    const filename = (entry.download && entry.download.filename) || `${entry.id}.bin`;
    return path.join(downloadDir, path.basename(filename));
  }

  function setProgress(id, patch) {
    const current = progress.get(id) || {
      phase: 'idle',
      received: 0,
      total: null,
      percent: 0,
      speedBps: 0,
      message: '',
      error: null,
      updatedAt: Date.now()
    };
    const next = { ...current, ...patch, updatedAt: Date.now() };
    if (next.total) next.percent = Math.min(100, Math.round((next.received / next.total) * 100));
    progress.set(id, next);
    return next;
  }

  function detect(id) {
    const cached = detectionCache.get(id);
    if (cached) return cached;
    let value;
    try {
      if (detectionPending.has(id)) return { detected: false, detail: 'checking' };
      value = detectFn(id) || { detected: false, detail: '' };
      if (value && typeof value.then === 'function') {
        const promise = value.then(result => { detectionCache.set(id, { detected: result?.detected === true, detail: String(result?.detail || '') }); }).catch(error => { detectionCache.set(id, { detected: false, detail: error.message }); }).finally(() => detectionPending.delete(id));
        detectionPending.set(id, promise);
        return { detected: false, detail: 'checking' };
      }
    } catch (error) {
      value = { detected: false, detail: error instanceof Error ? error.message : String(error) };
    }
    if (typeof value !== 'object') value = { detected: Boolean(value), detail: '' };
    const normalized = { detected: value.detected === true, detail: String(value.detail || '') };
    detectionCache.set(id, normalized);
    return normalized;
  }
  async function recheck(id) {
    if (detectionPending.has(id)) await detectionPending.get(id);
    detectionCache.delete(id);
    detect(id);
    if (detectionPending.has(id)) await detectionPending.get(id);
    return detect(id);
  }

  function stateOf(id) {
    return state.installed[id] || null;
  }

  function view(entry) {
    const id = entry.id;
    const probe = detect(id);
    const installed = stateOf(id);
    const requirements = Array.isArray(entry.requires) ? entry.requires : [];
    const ready = probe.detected && requirements.every(dependency => detect(dependency).detected);
    const dependencyRestart = requirements.some(dependency => stateOf(dependency)?.restartRequired === true && !detect(dependency).detected);
    const live = progress.get(id);
    const file = downloadPathOf(entry);
    const hasFile = fs.existsSync(file);
    const phase = live ? live.phase : installed?.restartRequired ? 'restart-required' : installed ? 'installed' : hasFile ? 'downloaded' : 'idle';
    return {
      id,
      names: entry.names || { 'zh-CN': entry.id, 'en-US': entry.id },
      summary: entry.summary || {},
      kind: entry.kind || 'tool',
      license: entry.license || '',
      homepage: entry.homepage || '',
      version: entry.version || null,
      installKind: (entry.install && entry.install.type) || 'manual',
      canLaunch: Boolean(entry.launch && entry.launch.entry),
      needsRestart: Boolean(entry.install && entry.install.requiresRestart),
      restartRequired: !ready && (phase === 'restart-required' || installed?.restartRequired === true || dependencyRestart),
      busy: operations.has(id) || downloads.has(id),
      download: entry.download ? {
        filename: path.basename(entry.download.filename || file),
        expectedBytes: entry.download.size || null,
        url: entry.download.url || null
      } : null,
      // A component can be present on the system without having been fetched
      // by us (user installed the driver manually), so expose both signals.
      detected: probe.detected,
      ready,
      requirements,
      detection: probe.detail,
      installedByApp: Boolean(installed),
      installedAt: installed ? installed.installedAt || null : null,
      sha256: (installed && installed.sha256) || state.hashes[id] || null,
      installDir: installed ? installed.path || installDirOf(id) : null,
      downloaded: hasFile,
      downloadedBytes: hasFile ? fs.statSync(file).size : 0,
      progress: live || { phase, received: 0, total: null, percent: 0, speedBps: 0, message: '', error: null }
    };
  }

  function list() {
    return entries.map(view);
  }

  async function runDownload(entry) {
    const id = entry.id;
    const download = entry.download;
    if (!download || !download.url) throw new Error('no_download');
    const filename = path.basename(download.filename || `${id}.bin`);
    const target = path.join(downloadDir, filename);
    const partial = `${target}.part`;
    const startedAt = Date.now();
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastReport = 0;

    setProgress(id, { phase: 'downloading', received: 0, total: download.size || null, percent: 0, speedBps: 0, message: '', error: null });
    let request = null;

    try {
      const opened = await (options.openStream || openStream)(download.url);
      request = opened.request;
      const stream = opened.stream;
      downloads.set(id, request);
      await new Promise((resolve, reject) => {
        const sink = fs.createWriteStream(partial);
        let settled = false;
        const fail = error => {
          if (settled) return;
          settled = true;
          sink.destroy();
          try { fs.unlinkSync(partial); } catch { /* already gone */ }
          reject(error);
        };
        stream.on('data', chunk => {
          received += chunk.length;
          if (received > MAX_DOWNLOAD_BYTES) {
            request.destroy();
            return fail(new Error('too_large'));
          }
          hash.update(chunk);
          const now = Date.now();
          if (now - lastReport > 180) {
            lastReport = now;
            const elapsed = Math.max(0.001, (now - startedAt) / 1000);
            setProgress(id, {
              phase: 'downloading',
              received,
              total: Number(stream.headers['content-length']) || download.size || null,
              speedBps: Math.round(received / elapsed)
            });
          }
        });
        stream.on('error', fail);
        stream.on('end', () => {
          if (settled) return;
          settled = true;
          sink.end(() => resolve());
        });
        sink.on('error', fail);
        stream.pipe(sink);
      });

      // A pinned hash is authoritative when present; otherwise the first
      // successful download establishes a hash we warn about if it changes.
      const digest = hash.digest('hex');
      const expected = String(download.sha256 || '').toLowerCase();
      if (expected && expected !== digest) {
        try { fs.unlinkSync(partial); } catch { /* ignore */ }
        throw new Error('sha256_mismatch');
      }
      const previous = state.hashes[id];
      if (!expected && previous && previous !== digest) {
        log(`component ${id}: download hash changed ${previous.slice(0, 12)} → ${digest.slice(0, 12)}`);
      }
      state.hashes[id] = digest;
      writeJson(stateFile, state);

      fs.renameSync(partial, target);
      setProgress(id, { phase: 'downloaded', received, percent: 100, speedBps: 0, message: digest, error: null });
      log(`component ${id}: downloaded ${received} bytes sha256=${digest.slice(0, 12)}`);
      return { ok: true, id, path: target, bytes: received, sha256: digest };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProgress(id, { phase: 'error', error: message, message: '' });
      throw error;
    } finally {
      downloads.delete(id);
    }
  }

  function download(id) {
    const entry = entryOf(id);
    if (!entry) throw new Error('unknown_component');
    if (!entry.download || !entry.download.url) throw new Error('no_download');
    if (operations.has(id)) throw new Error('component_busy');
    const live = progress.get(id);
    if (live && (live.phase === 'downloading' || live.phase === 'verifying')) return { ok: true, already: true };

    const promise = runDownload(entry).catch(error => {
      log(`component ${id}: download failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    // Detached on purpose: the HTTP handler returns immediately and the UI
    // polls /api/components for progress.
    void promise;
    return { ok: true, started: true };
  }

  async function extractZip(zipPath, targetDir) {
    if (options.extractZip) return options.extractZip(zipPath, targetDir);
    ensureDir(targetDir);
    if (process.platform === 'win32') {
      const script = `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(targetDir)} -Force`;
      await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
      return;
    }
    await runProcess('unzip', ['-o', zipPath, '-d', targetDir]);
  }

  function findInstaller(dir) {
    const candidates = [];
    const walk = (current, depth) => {
      if (depth > 2) return;
      let items = [];
      try { items = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const item of items) {
        const full = path.join(current, item.name);
        if (item.isDirectory()) walk(full, depth + 1);
        else if (/\.(exe|msi)$/i.test(item.name)) candidates.push(full);
      }
    };
    walk(dir, 0);
    if (!candidates.length) return null;
    const preferred = candidates.find(file => /setup.*x64.*\.exe$/i.test(file))
      || candidates.find(file => /setup.*\.exe$/i.test(file))
      || candidates.find(file => /\.exe$/i.test(file))
      || candidates[0];
    return preferred;
  }

  /** Exact-name lookup for portable packages that are extracted as-is. */
  function findFile(dir, name) {
    if (!name) return null;
    const wanted = name.toLowerCase();
    let found = null;
    const walk = (current, depth) => {
      if (found || depth > 3) return;
      let items = [];
      try { items = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const item of items) {
        if (found) return;
        const full = path.join(current, item.name);
        if (item.isDirectory()) walk(full, depth + 1);
        else if (item.name.toLowerCase() === wanted) found = full;
      }
    };
    walk(dir, 0);
    return found;
  }

  function runProcess(file, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let errors = '';
      child.stdout.on('data', value => { output = (output + value).slice(-8192); });
      child.stderr.on('data', value => { errors = (errors + value).slice(-2048); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`process_failed_${code}:${(errors || output).slice(-300)}`)));
    });
  }

  async function launchElevated(file, cwd, entry) {
    if (options.installRunner) return options.installRunner(file, entry);
    if (process.platform !== 'win32') {
      throw new Error('unsupported_platform');
    }
    // Check the publisher before showing UAC. -Wait includes the installer's
    // descendant processes; launching successfully alone is never success.
    const signer = entry.install?.publisher;
    const check = signer ? `$sig=Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}; if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notlike ${psQuote('*' + signer + '*')}) { throw 'publisher_signature_invalid' };` : '';
    const isMsi = /\.msi$/i.test(file);
    const command = isMsi ? 'msiexec.exe' : file;
    const args = isMsi ? ` -ArgumentList @('/i', ${psQuote('"' + file + '"')}, '/passive', '/norestart')` : '';
    const script = `$ErrorActionPreference='Stop'; try { ${check} $p=Start-Process -FilePath ${psQuote(command)} -WorkingDirectory ${psQuote(cwd)}${args} -Verb RunAs -PassThru -Wait; Write-Output $p.ExitCode } catch { if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.InnerException.NativeErrorCode -eq 1223) { Write-Output 'cancelled' } else { Write-Error $_ }; exit 1 }`;
    try {
      const result = String(await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
      const code = Number(result.split(/\r?\n/).pop());
      if (!Number.isInteger(code)) throw new Error('installer_result_missing');
      return code;
    } catch (error) {
      if (String(error).includes('1223') || String(error).includes('cancelled')) throw new Error('elevation_cancelled');
      throw error;
    }
  }

  async function runInstall(id, localFile) {
    const entry = entryOf(id);
    if (!entry) throw new Error('unknown_component');
    if ((entry.install && entry.install.type) === 'bundled' || id === 'uxplay') throw new Error('bundled_component_managed_by_airplay_lines');
    const kind = (entry.install && entry.install.type) || 'manual';
    if (kind === 'manual') throw new Error('manual_install');

    const file = localFile || downloadPathOf(entry);
    if (!fs.existsSync(file)) throw new Error('not_downloaded');
    if (!localFile) {
      const digest = crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex');
      if (digest !== (entry.download?.sha256 || state.hashes[id])) { await fs.promises.unlink(file); throw new Error('sha256_mismatch'); }
    }
    const targetDir = installDirOf(id);
    let installer = null;

    if (kind === 'zip-portable') {
      // Portable package: unpack into our own directory and stop. Launching is
      // a separate, explicit action so installing never starts a tray app.
      setProgress(id, { phase: 'extracting', message: '', error: null });
      await extractZip(file, targetDir);
      const executable = findFile(targetDir, entry.install.entry || '') || findInstaller(targetDir);
      if (!executable) throw new Error('installer_missing');
      state.installed[id] = {
        installedAt: Date.now(),
        path: targetDir,
        executable,
        sha256: state.hashes[id] || null,
        version: entry.version || null
      };
      writeJson(stateFile, state);
      detectionCache.delete(id);
      setProgress(id, { phase: 'installed', percent: 100 });
      log(`component ${id}: portable package extracted to ${targetDir}`);
      return { ok: true, id, path: targetDir, executable };
    }

    if (/\.zip$/i.test(file) && (localFile || kind === 'zip-launch' || kind === 'zip')) {
      setProgress(id, { phase: 'extracting', message: '', error: null });
      await extractZip(file, targetDir);
      installer = entry.install.entry ? path.join(targetDir, entry.install.entry) : null;
      if (!entry.install.entry) installer = findInstaller(targetDir);
      if (installer && !fs.existsSync(installer)) throw new Error('installer_missing');
      if (kind === 'zip' && !installer) {
        state.installed[id] = { installedAt: Date.now(), path: targetDir, sha256: state.hashes[id] || null };
        writeJson(stateFile, state);
        setProgress(id, { phase: 'installed', percent: 100 });
        return { ok: true, id, path: targetDir };
      }
    } else if (localFile || kind === 'exe' || kind === 'msi') {
      installer = file;
    }

    if (!installer) throw new Error('installer_missing');
    setProgress(id, { phase: 'installing', message: installer, error: null });
    try {
      const exitCode = await launchElevated(installer, path.dirname(installer), entry);
      if (![0, 3010, 1641].includes(exitCode)) throw new Error(exitCode === 1602 ? 'installation_cancelled' : `installer_exit_${exitCode}`);
      detectionCache.delete(id);
      const probe = await recheck(id);
      const restart = exitCode === 3010 || exitCode === 1641 || (entry.install.requiresRestart && !probe.detected);
      if (!probe.detected && !restart) throw new Error('installation_not_detected');
      state.installed[id] = { installedAt: Date.now(), path: targetDir, installer, sha256: localFile ? null : state.hashes[id] || null, version: entry.version || null, restartRequired: restart, exitCode };
      writeJson(stateFile, state);
      setProgress(id, { phase: restart ? 'restart-required' : 'installed', percent: 100, message: '', error: null });
      log(`component ${id}: installer exited ${exitCode}, detected=${probe.detected}, restart=${restart}`);
      return { ok: true, id, detected: probe.detected, restartRequired: restart };
    } catch (error) {
      setProgress(id, { phase: 'error', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  function locked(id, task) {
    if (operations.has(id) || ['downloading', 'installing', 'extracting'].includes(progress.get(id)?.phase)) throw new Error('component_busy');
    const promise = Promise.resolve().then(task).catch(error => { setProgress(id, { phase: 'error', error: error.message }); throw error; }).finally(() => operations.delete(id));
    operations.set(id, promise);
    return promise;
  }
  function install(id) { return locked(id, () => runInstall(id)); }

  function setup(id) {
    const entry = entryOf(id);
    if (!entry) throw new Error('unknown_component');
    function validateDependencies(current, trail = new Set()) {
      if (trail.has(current.id)) throw new Error('component_dependency_cycle');
      const next = new Set(trail); next.add(current.id);
      for (const dependency of current.requires || []) {
        const required = entryOf(dependency);
        if (!required) throw new Error('unknown_component_dependency');
        validateDependencies(required, next);
      }
    }
    validateDependencies(entry);
    if (operations.has(id)) return { ok: true, already: true };
    if (detect(id).detected && (entry.requires || []).every(dependency => detect(dependency).detected)) return { ok: true, already: true };
    const bundled = entry.install?.type === 'bundled';
    if (!bundled && !entry.download) throw new Error('no_download');
    void locked(id, async () => {
      // A bundled plugin was deployed by the main installer. Never fetch a
      // third-party tray wrapper or compile code on the user's computer.
      const own = await recheck(id);
      if (bundled && !own.detected) throw new Error('bundled_runtime_missing_reinstall');
      for (const dependency of entry.requires || []) {
        setProgress(id, { phase: 'installing', message: dependency, error: null });
        if (operations.has(dependency)) await operations.get(dependency);
        if (!(await recheck(dependency)).detected) {
          setup(dependency);
          if (operations.has(dependency)) await operations.get(dependency);
        }
        if (!(await recheck(dependency)).detected) {
          if (!stateOf(dependency)?.restartRequired) throw new Error('dependency_not_detected');
          state.installed[id] = { installedAt: Date.now(), version: entry.version || null, bundled, restartRequired: true };
          writeJson(stateFile, state);
          setProgress(id, { phase: 'restart-required', percent: 100, message: dependency, error: null });
          return { ok: true, id, restartRequired: true };
        }
      }
      if (bundled) {
        state.installed[id] = { installedAt: Date.now(), version: entry.version || null, bundled: true, restartRequired: false };
        writeJson(stateFile, state);
        setProgress(id, { phase: 'installed', percent: 100, message: '', error: null });
        return { ok: true, id, ready: true };
      }
      // A first list request may still be checking an installed service.
      if ((await recheck(id)).detected) { setProgress(id, { phase: 'installed', error: null }); return { ok: true, already: true }; }
      if (!fs.existsSync(downloadPathOf(entry))) await runDownload(entry);
      return runInstall(id);
    }).catch(error => log(`component ${id}: setup failed: ${error.message}`));
    return { ok: true, started: true };
  }

  function installLocal(id, filePath) {
    const entry = entryOf(id);
    if (!entry) throw new Error('unknown_component');
    if ((entry.install && entry.install.type) === 'bundled' || id === 'uxplay') throw new Error('bundled_component_managed_by_airplay_lines');
    const source = path.resolve(String(filePath || ''));
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('file_not_found');
    const ext = path.extname(source).toLowerCase();
    if (!['.exe', '.msi', '.zip'].includes(ext)) throw new Error('unsupported_file');

    return locked(id, () => runInstall(id, source));
  }

  function launch(id) {
    if (id === 'uxplay') throw new Error('use_canvas_airplay_lines');
    const entry = entryOf(id);
    if (!entry || !entry.launch || !entry.launch.entry) throw new Error('not_launchable');
    const record = state.installed[id];
    const baseDir = (record && record.path) || installDirOf(id);
    let executable = (record && record.executable) || findFile(baseDir, entry.launch.entry);
    if (!executable || !fs.existsSync(executable)) {
      // A receiver installed by its own MSI lives outside our directory.
      const probe = detect(id);
      executable = probe.detail && /\.exe$/i.test(probe.detail) ? probe.detail : null;
    }
    if (!executable || !fs.existsSync(executable)) throw new Error('not_installed');
    const child = spawn(executable, [], {
      cwd: path.dirname(executable),
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    log(`component ${id}: launched ${executable}`);
    return { ok: true, id, executable };
  }

  function cancel(id) {
    if (operations.has(id) && ['installing', 'extracting'].includes(progress.get(id)?.phase)) throw new Error('use_installer_to_cancel');
    const request = downloads.get(id);
    if (request) {
      try { request.destroy(new Error('cancelled')); } catch { /* already gone */ }
      downloads.delete(id);
    }
    setProgress(id, { phase: 'idle', received: 0, percent: 0, speedBps: 0, error: null, message: '' });
    return { ok: true, id, cancelled: Boolean(request) };
  }

  function remove(id) {
    if (operations.has(id)) throw new Error('component_busy');
    const entry = entryOf(id);
    if (!entry) throw new Error('unknown_component');
    if ((entry.install && entry.install.type) === 'bundled' || id === 'uxplay') throw new Error('bundled_component_managed_by_airplay_lines');
    const dir = (state.installed[id] && state.installed[id].path) || installDirOf(id);
    // Only delete inside our own component directory: a manifest path can
    // never make this remove something else on disk.
    const resolved = path.resolve(dir);
    if (resolved.startsWith(path.resolve(componentsDir) + path.sep)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
    delete state.installed[id];
    writeJson(stateFile, state);
    // Reclaim the downloaded package too: the AirPlay receiver is ~108 MB and
    // leaving it behind after "remove" would surprise anyone watching disk use.
    try {
      const file = downloadPathOf(entry);
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    } catch { /* file may be locked; keep the state clean anyway */ }
    detectionCache.delete(id);
    setProgress(id, { phase: 'idle', received: 0, percent: 0, speedBps: 0, error: null, message: '' });
    return { ok: true, id };
  }

  function openDir(id) {
    const entry = entryOf(id);
    if (!entry) throw new Error('unknown_component');
    const dir = fs.existsSync(installDirOf(id)) ? installDirOf(id) : downloadDir;
    if (process.platform === 'win32') {
      spawn('explorer.exe', [dir], { detached: true, windowsHide: true }).unref();
    } else {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true }).unref();
    }
    return { ok: true, id, path: dir };
  }

  function action(id, name, payload) {
    switch (name) {
      case 'setup': return setup(id);
      case 'download': return download(id);
      case 'install': return install(id);
      case 'install-local': return installLocal(id, payload && payload.path);
      case 'cancel': return cancel(id);
      case 'remove': return remove(id);
      case 'open': return openDir(id);
      case 'launch': return launch(id);
      case 'rescan': return Promise.all(entries.map(item => recheck(item.id))).then(() => ({ ok: true, id }));
      default: throw new Error('unknown_action');
    }
  }

  return {
    list,
    action,
    install,
    download,
    cancel,
    remove,
    openDir,
    installLocal,
    componentsDir,
    downloadDir
  };
}

module.exports = { createComponentManager };
