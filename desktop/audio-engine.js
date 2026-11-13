const { EventEmitter } = require('events');

const UINT32_HALF = 0x80000000;

function sequenceDistance(a, b) {
  return ((a >>> 0) - (b >>> 0)) >>> 0;
}

function isAhead(sequence, reference) {
  const distance = sequenceDistance(sequence, reference);
  return distance !== 0 && distance < UINT32_HALF;
}

function toFiniteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function monotonicNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

// Adaptive jitter buffer with per-source latency observability.
// Design inspired by the Foundation Sunshine reference project:
// - bounded recent-history windows drive target growth/shrink decisions
//   (its dynamic FEC estimator uses ten one-second buckets; we keep the same
//   "fast response to new loss, slow decay after a healthy window" shape);
// - RFC 3550-style EWMA for inter-arrival jitter;
// - arrival timestamps per frame so the realized buffer delay (arrival ->
//   playout) is measurable instead of estimated.
class JitterBuffer {
  constructor({ targetMs = 20, sampleRate = 48000, channels = 2, adaptive = true } = {}) {
    this.sampleRate = Math.max(1, sampleRate | 0);
    this.channels = Math.max(1, channels | 0);
    this.baseTarget = Math.max(1, Math.round(targetMs * this.sampleRate / 1000));
    this.target = this.baseTarget;
    this.adaptive = adaptive !== false;
    // Growth is capped so a pathological source cannot inflate playout latency
    // without bound; the cap is relative to the configured baseline.
    this.maxTarget = Math.min(this.baseTarget + Math.round(200 * this.sampleRate / 1000),
      Math.round(250 * this.sampleRate / 1000));
    this.frames = new Map();
    this.next = null;
    this.current = null;
    this.started = false;
    this.queuedFrames = 0;
    this.lastFrameCount = 0;
    this.metrics = { pushed: 0, duplicates: 0, late: 0, lost: 0, invalid: 0, starved: 0, resynced: 0, overflowed: 0, overrun: 0, framesIn: 0, framesOut: 0 };
    this.jitterMs = 0;
    this.bufferDelayMs = 0;
    this._delayInitialized = false;
    this._lastArrival = null;
    this._lastSequence = null;
    this._lastPushAt = 0;
    this._starves = [];
    this._lastAdapt = 0;
    this._lastDecay = 0;
    this._overSince = 0;
    this._lastOverrun = 0;
    this._lastGrow = 0;
    this._lastGrowAt = -1e9;
    this._pendingShortfall = 0;
    this._firstPushAt = null;
  }

  push(sequence, pcm, arrivalTime) {
    const seq = sequence >>> 0;
    if (!(pcm instanceof Float32Array) && !ArrayBuffer.isView(pcm) && !Array.isArray(pcm)) {
      this.metrics.invalid++;
      return false;
    }
    if (this.next === null) this.next = seq;
    if ((this.current && this.current.sequence === seq) || this.frames.has(seq)) {
      this.metrics.duplicates++;
      return false;
    }
    if (seq !== this.next && !isAhead(seq, this.next)) {
      this.metrics.late++;
      return false;
    }
    const frameCount = Math.floor(pcm.length / this.channels);
    if (frameCount <= 0) {
      this.metrics.invalid++;
      return false;
    }
    const arrival = Number.isFinite(arrivalTime) ? arrivalTime : null;
    const clean = new Float32Array(frameCount * this.channels);
    for (let i = 0; i < clean.length; i++) clean[i] = toFiniteNumber(Number(pcm[i]));
    this.frames.set(seq, { pcm: clean, arrival, frameCount });
    this._observeArrival(seq, arrival, frameCount);
    this.queuedFrames += frameCount;
    this.lastFrameCount = frameCount;
    this.metrics.pushed++;
    this.metrics.framesIn += frameCount;
    this._lastPushAt = monotonicNow();
    this._trimBacklog();
    return true;
  }

  // Hard backlog cap. A source that is online but not routed to any output is
  // never popped, so without a cap its buffer grows without bound (observed:
  // 2.1 s and climbing on an unrouted phone stream). Trim the oldest queued
  // packets down to half the cap so trimming is amortized, and resume the
  // timeline at the oldest surviving packet.
  _trimBacklog() {
    const hardLimit = Math.max(this.maxTarget * 2, Math.round(this.sampleRate * 1));
    if (this.queuedFrames <= hardLimit) return;
    const targetFloor = Math.round(hardLimit / 2);
    for (const [key, record] of this.frames) {
      if (this.queuedFrames <= targetFloor) break;
      this.frames.delete(key);
      this.queuedFrames -= record.frameCount;
      this.metrics.overflowed++;
    }
    const resumeAt = this._nextQueuedSequence();
    if (resumeAt !== null) this.next = resumeAt;
  }

  _observeArrival(sequence, arrival, frameCount) {
    if (this._firstPushAt === null) this._firstPushAt = monotonicNow();
    if (arrival === null) return;
    if (this._lastArrival !== null && sequence === ((this._lastSequence + 1) >>> 0)) {
      const packetMs = frameCount * 1000 / this.sampleRate;
      const interval = Math.max(0, arrival - this._lastArrival);
      const deviation = Math.abs(interval - packetMs);
      this.jitterMs += (deviation - this.jitterMs) / 16;
    }
    this._lastArrival = arrival;
    this._lastSequence = sequence >>> 0;
  }

  _beginCurrent() {
    if (this.current) return;
    const record = this.frames.get(this.next);
    if (record) {
      this.frames.delete(this.next);
      this.current = { sequence: this.next, pcm: record.pcm, arrival: record.arrival, offsetFrames: 0 };
      if (record.arrival !== null) {
        const delay = Math.max(0, monotonicNow() - record.arrival);
        if (!this._delayInitialized) {
          this.bufferDelayMs = delay;
          this._delayInitialized = true;
        } else {
          this.bufferDelayMs += (delay - this.bufferDelayMs) / 8;
        }
      }
      return;
    }
    // Nothing queued for the expected sequence.
    //
    // Distinguishing "no observation yet" from "observed loss" matters (the
    // reference project makes the same distinction for its FEC estimator: a
    // missing feedback window is not zero loss, and an unobserved frame never
    // enters the loss denominator). Starvation must not advance the sequence:
    // the next packet may still be in flight, and advancing would mark it late
    // and discard usable audio. Only a packet that arrived *ahead* of `next`
    // proves that the gap is real.
    if (this.frames.size === 0) {
      this.current = { sequence: this.next, pcm: null, arrival: null, offsetFrames: 0, frameCount: this.lastFrameCount || 1, holding: true };
      return;
    }
    const target = this._nextQueuedSequence();
    if (target === null) {
      this.current = { sequence: this.next, pcm: null, arrival: null, offsetFrames: 0, frameCount: this.lastFrameCount || 1, holding: true };
      return;
    }
    // A queued packet ahead of `next` proves the gap is real. Emit one silence
    // block covering the whole gap (same total duration as advancing packet by
    // packet) and resume at the queued packet, so a large sequence jump cannot
    // spin the render loop frame by frame.
    const missing = sequenceDistance(target, this.next);
    if (missing > 64) this.metrics.resynced++;
    this.metrics.lost += missing;
    this.current = {
      sequence: this.next,
      pcm: null,
      arrival: null,
      offsetFrames: 0,
      frameCount: missing * (this.lastFrameCount || 1),
      resumeAt: target
    };
  }

  _nextQueuedSequence() {
    let target = null;
    let best = Infinity;
    for (const key of this.frames.keys()) {
      const distance = sequenceDistance(key, this.next);
      if (distance > 0 && distance < best) {
        best = distance;
        target = key;
      }
    }
    return target;
  }

  _finishCurrent() {
    // A silence block that stands in for a sequence gap resumes at the packet
    // that proved the gap; ordinary blocks advance one sequence.
    this.next = this.current && this.current.resumeAt !== undefined ? this.current.resumeAt : (this.next + 1) >>> 0;
    this.current = null;
  }

  _noteStarve() {
    const now = monotonicNow();
    this._starves.push(now);
    while (this._starves.length && now - this._starves[0] > 10500) this._starves.shift();
  }

  // Adaptive target control: grow quickly while recent starves exist, decay
  // slowly only after a fully healthy window (mirrors the reference project's
  // "highest bucket responds fast, complete healthy window allows recovery").
  // Growth is keyed to the newest starve event, not to the presence of any
  // starve in the window: the same event must not inflate the target on every
  // 250 ms tick (which previously pushed a 20 ms baseline to 90 ms).
  _adapt() {
    if (!this.adaptive) return;
    const now = monotonicNow();
    if (now - this._lastAdapt < 250) return;
    this._lastAdapt = now;
    const newestStarve = this._starves.length ? this._starves[this._starves.length - 1] : 0;
    if (newestStarve > this._lastGrow && now - this._lastGrowAt >= 1000) {
      this._lastGrow = newestStarve;
      this._lastGrowAt = now;
      const shortfallMs = this._pendingShortfall * 1000 / this.sampleRate;
      this._pendingShortfall = 0;
      // Small, bounded steps: one rare short must not permanently inflate
      // latency. Genuine sustained jitter still converges over a few seconds.
      const growMs = Math.max(2, Math.min(6, Math.max(shortfallMs, this.jitterMs)));
      this.target = Math.min(this.maxTarget, this.target + Math.max(1, Math.round(growMs * this.sampleRate / 1000)));
      return;
    }
    const lastStarve = this._starves.length ? this._starves[this._starves.length - 1] : 0;
    if (this._firstPushAt !== null && now - this._firstPushAt >= 3000 &&
        now - lastStarve >= 3000 && now - this._lastDecay >= 1000) {
      this._lastDecay = now;
      const decay = Math.max(1, Math.round(2 * this.sampleRate / 1000));
      if (this.target - decay >= this.baseTarget) this.target -= decay;
    }
  }

  pop(frameCount) {
    const count = Math.max(0, frameCount | 0);
    const out = new Float32Array(count * this.channels);
    if (count === 0 || this.next === null) return out;
    if (!this.started) {
      if (this.queuedFrames < this.target) return out;
      this.started = true;
    }
    let writtenFrames = 0;
    while (writtenFrames < count) {
      this._beginCurrent();
      if (!this.current) continue; // a proven gap advanced `next`; retry
      const current = this.current;
      if (current.holding) {
        // Starving: emit silence but keep `next` so the in-flight packet can
        // still play out. Growth is reported through _adapt().
        this.current = null;
        break;
      }
      const availableFrames = current.pcm
        ? current.pcm.length / this.channels - current.offsetFrames
        : current.frameCount - current.offsetFrames;
      const take = Math.min(count - writtenFrames, Math.max(0, availableFrames));
      if (take <= 0) {
        this._finishCurrent();
        continue;
      }
      if (current.pcm) {
        const sourceStart = current.offsetFrames * this.channels;
        const sourceEnd = sourceStart + take * this.channels;
        out.set(current.pcm.subarray(sourceStart, sourceEnd), writtenFrames * this.channels);
        this.queuedFrames = Math.max(0, this.queuedFrames - take);
        this.metrics.framesOut += take;
      }
      current.offsetFrames += take;
      writtenFrames += take;
      if (current.offsetFrames >= (current.pcm ? current.pcm.length / this.channels : current.frameCount)) {
        this._finishCurrent();
      }
    }
    if (writtenFrames < count) {
      // Any shortfall is starvation, not just a completely empty queue: the
      // consumer asked for a full render block and got silence for part of it.
      // Only shorts that happen while data is still flowing are jitter signals;
      // a paused source would otherwise inflate the adaptive target forever.
      this.metrics.starved++;
      this._pendingShortfall = Math.max(this._pendingShortfall, count - writtenFrames);
      if (monotonicNow() - this._lastPushAt <= 300) this._noteStarve();
    }
    this._adapt();
    this._enforceLatency(monotonicNow());
    return out;
  }

  // Soft latency governor. A transient sender burst (or a late render tick)
  // leaves the queue above target forever, because supply and consumption are
  // both real-time; prebuffering alone only sets the floor, it never pulls the
  // floor back down. When the queue stays above target + 30 ms for two seconds,
  // drop the oldest whole packet (rate-limited to one per 500 ms) and count it
  // as `overrun`. One 5 ms packet every few seconds is inaudible; unbounded
  // backlog growth is not.
  _enforceLatency(nowMs) {
    if (!this.started) return;
    const softLimit = this.target + Math.round(20 * this.sampleRate / 1000);
    if (this.queuedFrames <= softLimit) {
      this._overSince = 0;
      return;
    }
    if (!this._overSince) {
      this._overSince = nowMs;
      return;
    }
    if (nowMs - this._overSince < 1500) return;
    if (nowMs - this._lastOverrun < 500) return;
    const oldest = this._nextQueuedSequence();
    if (oldest === null) return;
    const record = this.frames.get(oldest);
    if (!record) return;
    this.frames.delete(oldest);
    this.queuedFrames -= record.frameCount;
    this.metrics.overrun++;
    this._lastOverrun = nowMs;
    if (this.next === oldest) this.next = this._nextQueuedSequence() ?? ((this.next + 1) >>> 0);
  }

  // The render cadence is the dominant buffer requirement: a 15 ms render
  // block cannot be fed from a 5 ms queue without starving. The server owns
  // that number (blockMsAvg) and pushes it down; keep it separate from the
  // adaptive floor so a cadence change cannot ratchet latency upwards.
  setBaseTargetMs(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const frames = Math.max(1, Math.round(ms * this.sampleRate / 1000));
    this.baseTarget = Math.min(this.maxTarget, frames);
    if (this.target < this.baseTarget) this.target = this.baseTarget;
  }

  stats() {
    return {
      occupancyMs: round2(this.queuedFrames * 1000 / this.sampleRate),
      targetMs: round2(this.target * 1000 / this.sampleRate),
      jitterMs: round2(this.jitterMs),
      bufferDelayMs: round2(this.bufferDelayMs),
      adaptive: this.adaptive,
      starved: this.metrics.starved,
      lost: this.metrics.lost,
      resynced: this.metrics.resynced,
      overflowed: this.metrics.overflowed,
      overrun: this.metrics.overrun,
      framesIn: this.metrics.framesIn,
      framesOut: this.metrics.framesOut,
      queuedFrames: this.queuedFrames,
      pushed: this.metrics.pushed
    };
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

class Mixer extends EventEmitter {
  constructor({ sampleRate = 48000, channels = 2, targetMs = 20, limiter = true } = {}) {
    super();
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.targetMs = targetMs;
    this.limiter = limiter;
    this.sources = new Map();
    this.buses = new Map();
    this.routes = [];
    this.metrics = { renders: 0, clippedSamples: 0, limitedSamples: 0 };
  }

  addSource(id) {
    if (!this.sources.has(id)) this.sources.set(id, {
      buffer: new JitterBuffer({ targetMs: this.targetMs, sampleRate: this.sampleRate, channels: this.channels }),
      gain: 1,
      muted: false,
      renderBuffer: null
    });
  }

  removeSource(id) { this.sources.delete(id); }
  setSource(id, patch) { const source = this.sources.get(id); if (source) Object.assign(source, patch); }

  addBus(id, patch = {}) {
    this.buses.set(id, { gain: 1, muted: false, ...patch, output: null });
  }

  setBus(id, patch) { const bus = this.buses.get(id); if (bus) Object.assign(bus, patch); }
  setRoutes(routes) { this.routes = Array.isArray(routes) ? routes.filter(r => Array.isArray(r) && r.length === 2) : []; }

  setTargetMs(ms) {
    this.targetMs = ms;
    for (const source of this.sources.values()) source.buffer.setBaseTargetMs(ms);
  }

  push(id, sequence, pcm, arrivalTime) {
    this.addSource(id);
    return this.sources.get(id).buffer.push(sequence, pcm, arrivalTime);
  }

  sourceStats() {
    const stats = new Map();
    for (const [id, source] of this.sources) stats.set(id, source.buffer.stats());
    return stats;
  }

  render(frameCount) {
    const count = Math.max(0, frameCount | 0);
    const length = count * this.channels;
    const result = new Map();
    const sourceSnapshots = new Map();
    for (const [sourceId, source] of this.sources) {
      if (!source.renderBuffer || source.renderBuffer.length !== length) source.renderBuffer = new Float32Array(length);
      source.renderBuffer.fill(0);
      source.renderBuffer.set(source.buffer.pop(count));
      sourceSnapshots.set(sourceId, source.renderBuffer);
    }
    for (const [id, bus] of this.buses) {
      if (!bus.output || bus.output.length !== length) bus.output = new Float32Array(length);
      bus.output.fill(0);
      if (!bus.muted) {
        const mixedSources = new Set();
        for (const [sourceId, busId] of this.routes) {
          if (busId !== id || mixedSources.has(sourceId)) continue;
          mixedSources.add(sourceId);
          const source = this.sources.get(sourceId);
          const pcm = sourceSnapshots.get(sourceId);
          if (!source || !pcm || source.muted) continue;
          const gain = toFiniteNumber(Number(source.gain), 0) * toFiniteNumber(Number(bus.gain), 0);
          for (let i = 0; i < length; i++) bus.output[i] += pcm[i] * gain;
        }
      }
      for (let i = 0; i < length; i++) {
        if (Math.abs(bus.output[i]) > 1) {
          this.metrics.clippedSamples++;
          if (this.limiter) {
            bus.output[i] = Math.max(-1, Math.min(1, bus.output[i]));
            this.metrics.limitedSamples++;
          }
        }
      }
      result.set(id, bus.output);
    }
    this.metrics.renders++;
    this.emit('render', result);
    return result;
  }
}

module.exports = { Mixer, JitterBuffer, sequenceDistance, isAhead };
