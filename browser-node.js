/**
 * MeshAudio 浏览器节点
 *
 * 把本机麦克风（或本页播放的音频）当作一个普通来源接入画布：
 *   1. POST /api/browser-source 注册，拿到稳定 sourceId / sourceHash / token
 *   2. WebSocket /browser-audio?token=... 发送 MSA1 包
 *   3. 服务端复用现有 UDP 入队路径，因此 Mixer / 引擎 / 路由 / 语音链全部共享
 *
 * 边界（不要在这里假装能做到）：
 *   - 需要安全上下文（HTTPS 或 localhost），iOS 否则不给麦克风
 *   - 只采本页麦克风或本页播放的音频，拿不到其他 App 的系统音频
 *   - iOS 锁屏 / 后台会中断采集，页面回到前台需重新开始
 */
(() => {
  'use strict';

  const TARGET_RATE = 48000;        // 与 protocol/README.md 的 MSA1 约定一致
  const BLOCK_FRAMES = 512;         // 48 kHz 下约 10.7 ms，一批一包
  const MAX_BUFFERED = 512 * 1024;  // WS 背压上限，超了丢批而不是无限积压

  const el = id => document.getElementById(id);
  const microphoneOnly = document.documentElement.dataset.microphoneOnly === 'true' || location.pathname === '/ios-node.html' || location.pathname.startsWith('/line/');
  if (microphoneOnly) {
    el('modeGroup').hidden = true;
    el('modeLabel').hidden = true;
    document.title = 'MeshAudio · iOS 网页麦克风';
    el('pageTitle').textContent = 'iOS 网页麦克风';
    el('deviceName').value = /iPad|iPhone|iPod/.test(navigator.userAgent) ? 'iOS 网页麦克风' : '网页麦克风';
  }

  const state = {
    mode: 'microphone',
    running: false,
    ctx: null,
    ws: null,
    stream: null,
    mediaEl: null,
    mediaUrl: null,
    sourceNode: null,
    processor: null,
    sink: null,
    oscillator: null,
    oscillatorGain: null,
    resampler: null,
    sourceHash: 0,
    token: null,
    sequence: 0,
    sent: 0,
    dropped: 0,
    levelTick: 0
  };

  // ---- 环境检查 ----------------------------------------------------------

  function checkEnvironment() {
    const problems = [];
    if (!window.isSecureContext) {
      problems.push('当前不是安全上下文，iOS / Android 会拒绝麦克风。请通过 HTTPS 访问（localhost 除外）。');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      problems.push('当前浏览器不支持 getUserMedia，无法采集音频。');
    }
    if (!problems.length) return;
    const banner = el('envWarn');
    banner.hidden = false;
    banner.classList.add('bad');
    banner.textContent = problems.join(' ');
  }

  // ---- 流式线性重采样 ----------------------------------------------------
  // AudioContext 的采样率由系统决定（iOS 常见 44.1 kHz 或 48 kHz）。MSA1 不携带
  // 采样率字段，服务端按 48 kHz 解析，所以这里必须显式转换，否则会变调。

  class LinearResampler {
    constructor(inputRate, outputRate) {
      this.ratio = inputRate / outputRate;
      this.pos = 0;
      this.prev = 0;
      this.primed = false;
    }

    process(input) {
      if (Math.abs(this.ratio - 1) < 1e-6) return input;
      const capacity = Math.ceil(input.length / this.ratio) + 4;
      const output = new Float32Array(capacity);
      let written = 0;
      let pos = this.pos;
      let prev = this.primed ? this.prev : (input[0] || 0);
      for (let index = 0; index < input.length; index++) {
        const current = input[index];
        while (pos < 1 && written < capacity) {
          output[written++] = prev + (current - prev) * pos;
          pos += this.ratio;
        }
        pos -= 1;
        prev = current;
      }
      this.pos = pos;
      this.prev = prev;
      this.primed = true;
      return output.subarray(0, written);
    }
  }

  // ---- MSA1 组包 ---------------------------------------------------------

  function buildPacket(stereo, frames) {
    const buffer = new ArrayBuffer(20 + frames * 2 * 4);
    const view = new DataView(buffer);
    view.setUint8(0, 0x4d); // M
    view.setUint8(1, 0x53); // S
    view.setUint8(2, 0x41); // A
    view.setUint8(3, 0x31); // 1
    view.setUint32(4, state.sourceHash >>> 0, true);
    view.setUint32(8, state.sequence >>> 0, true);
    view.setBigUint64(12, BigInt(Date.now()) * 1000n, true);
    new Float32Array(buffer, 20).set(stereo);
    state.sequence = (state.sequence + 1) >>> 0;
    return buffer;
  }

  // ---- 采集回调 ----------------------------------------------------------

  function onAudioProcess(event) {
    if (!state.running) return;
    const input = event.inputBuffer.getChannelData(0);
    if (!input.length) return;

    // 单声道 → 48 kHz → interleaved stereo（项目内部统一格式）
    const mono = state.resampler ? state.resampler.process(input) : input;
    const frames = mono.length;
    if (!frames) return;

    const stereo = new Float32Array(frames * 2);
    let energy = 0;
    for (let index = 0; index < frames; index++) {
      const sample = mono[index];
      stereo[index * 2] = sample;
      stereo[index * 2 + 1] = sample;
      energy += sample * sample;
    }

    const socket = state.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      state.dropped++;
      return;
    }
    // TCP 背压：宁可丢这一批，也不让页面内存和延迟一起涨。
    if (socket.bufferedAmount > MAX_BUFFERED) {
      state.dropped++;
      updateStats();
      return;
    }

    socket.send(buildPacket(stereo, frames));
    state.sent++;

    if ((state.levelTick++ & 3) === 0) {
      const rms = Math.sqrt(energy / frames);
      el('level').style.width = `${Math.min(100, rms * 320).toFixed(1)}%`;
      updateStats();
    }
  }

  // ---- 注册与连接 --------------------------------------------------------

  function deviceId() {
    const key = 'meshaudio-browser-device';
    try {
      let id = sessionStorage.getItem(key);
      if (!id) {
        id = `browser-${Math.random().toString(16).slice(2, 10)}`;
        sessionStorage.setItem(key, id);
      }
      return id;
    } catch {
      return `browser-${Math.random().toString(16).slice(2, 10)}`;
    }
  }

  async function register() {
    const response = await fetch('/api/browser-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: deviceId(),
        deviceName: el('deviceName').value.trim() || '网页麦克风',
        streamType: state.mode
      })
    });
    if (!response.ok) throw new Error(`注册来源失败（HTTP ${response.status}）`);
    return response.json();
  }

  function connect(session) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${location.host}${session.wsPath}?token=${encodeURIComponent(session.token)}`;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* already closed */ }
        reject(new Error('音频通道连接超时'));
      }, 5000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve(socket);
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('音频通道连接失败'));
      };
      socket.onclose = () => {
        if (state.running) { cleanup(); setStatus('来源已删除或连接已断开，可重新点击开始'); }
      };
      state.ws = socket;
    });
  }

  // ---- 媒体源 ------------------------------------------------------------

  async function prepareMedia(ctx) {
    const file = el('mediaFile').files?.[0];
    if (file) {
      if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
      state.mediaUrl = URL.createObjectURL(file);
      const audio = new Audio(state.mediaUrl);
      audio.loop = true;
      state.mediaEl = audio;
      return;
    }
    // 没有选文件时用测试音，保证「网页媒体」这条路可以独立验证。
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = 440;
    gain.gain.value = 0.2;
    oscillator.connect(gain);
    state.oscillator = oscillator;
    state.oscillatorGain = gain;
  }

  // ---- 启停 --------------------------------------------------------------

  async function start() {
    if (state.running) return;
    if (state.mode === 'microphone' && (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)) {
      setStatus('麦克风不可用：请打开并信任本机的 HTTPS 页面');
      return;
    }
    el('start').disabled = true;

    try {
      setStatus('请求音频权限…');

      // iOS 要求 AudioContext 的创建/恢复发生在用户手势的同步链路里；
      // 因此先同步建 context 并发起 resume，之后才 await 麦克风。
      const ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
      state.ctx = ctx;
      const resumePromise = ctx.resume();

      let stream = null;
      if (state.mode === 'microphone') {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            // 服务端已有 STFT 降噪 + VAD AGC，浏览器再做一轮只会双重处理。
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });
        state.stream = stream;
      } else {
        await prepareMedia(ctx);
      }

      await resumePromise;
      if (ctx.state !== 'running') await ctx.resume();

      setStatus('注册来源…');
      const session = await register();
      state.sourceHash = session.sourceHash;
      state.token = session.token;

      setStatus('连接音频通道…');
      await connect(session);

      const actualRate = ctx.sampleRate;
      el('sampleRate').textContent = `${actualRate} Hz`;
      state.resampler = Math.abs(actualRate - TARGET_RATE) > 1
        ? new LinearResampler(actualRate, TARGET_RATE)
        : null;

      const processor = ctx.createScriptProcessor(BLOCK_FRAMES, 1, 1);
      processor.onaudioprocess = onAudioProcess;
      state.processor = processor;

      // 极小但非零的增益：保持 AudioContext 有活跃输出（避免 iOS 判空挂起），
      // 同时用户几乎听不到自己的麦克风。
      const sink = ctx.createGain();
      sink.gain.value = 0.0001;
      sink.connect(ctx.destination);
      processor.connect(sink);
      state.sink = sink;

      if (state.mode === 'microphone') {
        const source = ctx.createMediaStreamSource(stream);
        source.connect(processor);
        state.sourceNode = source;
      } else if (state.mediaEl) {
        const source = ctx.createMediaElementSource(state.mediaEl);
        source.connect(processor);
        state.sourceNode = source;
        await state.mediaEl.play();
      } else if (state.oscillatorGain) {
        state.oscillatorGain.connect(processor);
        state.oscillator.start();
      }

      state.running = true;
      el('stop').disabled = false;
      setStatus(state.mode === 'microphone' ? '麦克风推流中' : '网页音频推流中');
    } catch (error) {
      cleanup();
      setStatus(error?.message || '启动失败');
      el('start').disabled = false;
    }
  }

  function cleanup() {
    state.running = false;
    for (const node of [state.processor, state.sourceNode, state.sink, state.oscillatorGain]) {
      try { node?.disconnect(); } catch { /* already detached */ }
    }
    try { state.oscillator?.stop(); } catch { /* never started */ }
    try { state.stream?.getTracks().forEach(track => track.stop()); } catch { /* already stopped */ }
    try { state.mediaEl?.pause(); } catch { /* not playing */ }
    if (state.mediaUrl) {
      URL.revokeObjectURL(state.mediaUrl);
      state.mediaUrl = null;
    }
    try { state.ws?.close(); } catch { /* already closed */ }
    try { state.ctx?.close(); } catch { /* already closed */ }

    state.processor = null;
    state.sourceNode = null;
    state.sink = null;
    state.oscillator = null;
    state.oscillatorGain = null;
    state.stream = null;
    state.mediaEl = null;
    state.ctx = null;
    state.ws = null;
    state.resampler = null;

    el('level').style.width = '0%';
    el('stop').disabled = true;
    el('start').disabled = false;
  }

  // ---- UI ----------------------------------------------------------------

  function setStatus(text) {
    el('status').textContent = text;
  }

  function updateStats() {
    el('packets').textContent = String(state.sent);
    el('dropped').textContent = String(state.dropped);
  }

  el('modeGroup').addEventListener('click', event => {
    const button = event.target.closest('button[data-mode]');
    if (!button || state.running) return;
    state.mode = button.dataset.mode;
    for (const item of el('modeGroup').querySelectorAll('button')) {
      item.classList.toggle('active', item === button);
    }
    el('mediaPanel').hidden = state.mode !== 'media';
  });

  el('start').addEventListener('click', start);
  el('stop').addEventListener('click', () => {
    cleanup();
    setStatus('已停止');
  });

  document.addEventListener('visibilitychange', () => {
    if (!state.running) return;
    if (document.hidden && microphoneOnly && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
      cleanup();
      setStatus('已进入后台，麦克风已停止；回到前台后请重新点击开始');
      return;
    }
    setStatus(document.hidden
      ? '页面已进入后台，采集可能被系统中断'
      : '推流中');
  });

  window.addEventListener('pagehide', cleanup);

  checkEnvironment();
})();
