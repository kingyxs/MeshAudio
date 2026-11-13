const assert = require('assert');
const { Mixer, JitterBuffer } = require('./audio-engine');

function values(buffer) { return Array.from(buffer); }
function close(actual, expected, message) {
  assert.strictEqual(actual.length, expected.length, message);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-6, `${message || 'value'}[${i}]: ${value} !== ${expected[i]}`));
}

{
  const mixer = new Mixer({ sampleRate: 1000, channels: 1, targetMs: 0 });
  mixer.addBus('bus');
  mixer.addSource('a');
  mixer.setRoutes([['a', 'bus'], ['a', 'bus']]);
  mixer.push('a', 1, Float32Array.from([0.25, 0.5]));
  close(mixer.render(2).get('bus'), [0.25, 0.5], 'fan-out must consume one source block once');
}

{
  const mixer = new Mixer({ sampleRate: 1000, channels: 1, targetMs: 0 });
  mixer.addBus('left'); mixer.addBus('right'); mixer.addSource('a');
  mixer.setRoutes([['a', 'left'], ['a', 'right']]);
  mixer.push('a', 1, Float32Array.from([0.4]));
  const rendered = mixer.render(1);
  close(rendered.get('left'), [0.4], 'left fan-out');
  close(rendered.get('right'), [0.4], 'right fan-out');
  assert.strictEqual(rendered.get('left'), rendered.get('left'), 'bus output is stable within a render');
}

{
  const mixer = new Mixer({ sampleRate: 1000, channels: 1, targetMs: 2 });
  mixer.addBus('bus'); mixer.addSource('a'); mixer.setRoutes([['a', 'bus']]);
  mixer.push('a', 10, Float32Array.from([1]));
  close(mixer.render(1).get('bus'), [0], 'prebuffer should initially output silence');
  mixer.push('a', 11, Float32Array.from([2]));
  mixer.push('a', 12, Float32Array.from([3]));
  close(mixer.render(1).get('bus'), [1], 'prebuffer releases the first packet');
  close(mixer.render(1).get('bus'), [1], 'prebuffered packet remains available');
  assert.strictEqual(mixer.sources.get('a').buffer.started, true);
}

{
  const mixer = new Mixer({ sampleRate: 1000, channels: 1, targetMs: 0 });
  mixer.addBus('bus'); mixer.addSource('a'); mixer.setRoutes([['a', 'bus']]);
  mixer.push('a', 1, Float32Array.from([0.25]));
  mixer.push('a', 3, Float32Array.from([0.75]));
  const first = values(mixer.render(1).get('bus'));
  close(first, [0.25], 'first packet');
  const missing = values(mixer.render(1).get('bus'));
  close(missing, [0], 'missing packet advances with silence');
  const recovered = values(mixer.render(1).get('bus'));
  close(recovered, [0.75], 'later packet is not stalled');
  assert.strictEqual(mixer.sources.get('a').buffer.metrics.lost, 1);
}

{
  const buffer = new JitterBuffer({ sampleRate: 1000, channels: 1, targetMs: 0 });
  buffer.push(0xffffffff, Float32Array.from([1]));
  buffer.push(0, Float32Array.from([2]));
  buffer.push(0, Float32Array.from([99]));
  buffer.push(0xffffffff, Float32Array.from([99]));
  close(buffer.pop(1), [1], 'uint32 wrap before zero');
  close(buffer.pop(1), [2], 'uint32 wrap after zero');
  assert.strictEqual(buffer.metrics.duplicates, 2);
}

{
  const mixer = new Mixer({ sampleRate: 1000, channels: 2, targetMs: 0 });
  mixer.addBus('bus', { gain: 0.5 }); mixer.addSource('a'); mixer.setRoutes([['a', 'bus']]);
  mixer.setSource('a', { gain: 0.5 });
  mixer.push('a', 1, [1, 2, NaN]);
  close(mixer.render(2).get('bus'), [0.25, 0.5, 0, 0], 'short and invalid PCM are safe');
  mixer.setSource('a', { muted: true });
  mixer.push('a', 2, Float32Array.from([1, 1, 1, 1]));
  close(mixer.render(2).get('bus'), [0, 0, 0, 0], 'source mute');
  mixer.setSource('a', { muted: false });
  mixer.setBus('bus', { muted: true });
  close(mixer.render(2).get('bus'), [0, 0, 0, 0], 'bus mute');
}

{
  const mixer = new Mixer({ sampleRate: 1000, channels: 1, targetMs: 0 });
  mixer.addBus('bus'); mixer.addSource('a'); mixer.setRoutes([['a', 'bus']]);
  mixer.push('a', 1, Float32Array.from([2, -3]));
  const first = mixer.render(2).get('bus');
  close(first, [1, -1], 'limiter clamps clipping');
  const second = mixer.render(2).get('bus');
  assert.strictEqual(first, second, 'bus output buffer is reused');
  assert.strictEqual(mixer.metrics.clippedSamples, 2);
  assert.strictEqual(mixer.metrics.limitedSamples, 2);
}

{
  // Adaptive target: starvation grows the buffer; growth stays bounded and is
  // never slower than the configured baseline.
  const buffer = new JitterBuffer({ sampleRate: 1000, channels: 1, targetMs: 10 });
  assert.strictEqual(buffer.target, 10, 'baseline target comes from targetMs');
  buffer.push(1, Float32Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]));
  close(buffer.pop(10), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 'prebuffer releases when target is met');
  assert.strictEqual(buffer.metrics.starved, 0, 'no starvation while data is queued');
  buffer._lastAdapt = -1e9;
  buffer.pop(1);
  assert.strictEqual(buffer.metrics.starved, 1, 'empty buffer while started counts as starvation');
  assert.ok(buffer.target > 10, 'starvation grows the adaptive target');
  assert.ok(buffer.target <= buffer.maxTarget, 'adaptive growth is bounded');
  const afterFirstGrowth = buffer.target;
  buffer._lastAdapt = -1e9;
  for (let i = 0; i < 10; i++) buffer.pop(1);
  assert.strictEqual(buffer.target, afterFirstGrowth, 'growth is rate-limited to once per second');
  assert.ok(buffer.target <= buffer.maxTarget, 'adaptive growth stays bounded');
  const stats = buffer.stats();
  assert.strictEqual(stats.adaptive, true);
  assert.ok(stats.targetMs >= 10);
  assert.ok(stats.starved >= 1);
  assert.strictEqual(stats.lost, 0, 'starvation is not packet loss (no later packet proves a gap)');
}

{
  // A gap is only counted once a later packet proves it, and the missing span
  // is emitted as one silence block of the correct duration.
  const buffer = new JitterBuffer({ sampleRate: 1000, channels: 1, targetMs: 0 });
  buffer.push(1, Float32Array.from([1]));
  buffer.push(6, Float32Array.from([6]));
  close(buffer.pop(1), [1], 'first packet');
  close(buffer.pop(1), [0], 'gap opens with silence');
  for (let i = 0; i < 3; i++) close(buffer.pop(1), [0], 'gap silence continues');
  close(buffer.pop(1), [6], 'queued packet plays after the gap');
  assert.strictEqual(buffer.metrics.lost, 4, 'four missing sequences reported once');
  assert.strictEqual(buffer.metrics.resynced, 0, 'small gaps are not resyncs');
}

{
  // Large sequence jumps resynchronize instead of walking the gap frame by frame.
  const buffer = new JitterBuffer({ sampleRate: 1000, channels: 1, targetMs: 0 });
  buffer.push(1, Float32Array.from([1]));
  buffer.push(5000, Float32Array.from([5]));
  close(buffer.pop(1), [1], 'pre-jump packet');
  const silence = buffer.pop(1);
  close(silence, [0], 'jump emits silence, not the queued packet');
  assert.strictEqual(buffer.metrics.resynced, 1);
  assert.ok(buffer.metrics.lost >= 4998);
}

{
  // Per-source latency: arrival timestamps turn into a measured buffer delay.
  const buffer = new JitterBuffer({ sampleRate: 1000, channels: 1, targetMs: 0 });
  const arrival = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - 30;
  buffer.push(7, Float32Array.from([0.5]), arrival);
  close(buffer.pop(1), [0.5], 'timestamped packet plays out');
  const stats = buffer.stats();
  assert.ok(stats.bufferDelayMs >= 25 && stats.bufferDelayMs <= 80, `buffer delay measured: ${stats.bufferDelayMs}`);
  assert.strictEqual(stats.occupancyMs, 0, 'occupancy drains after playout');
  buffer.push(8, Float32Array.from([0.25, 0.25]), (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  assert.strictEqual(buffer.stats().occupancyMs, 2, 'occupancy reports queued audio milliseconds');
}

{
  // Inter-arrival jitter is an EWMA over sequence-continuous packets.
  const buffer = new JitterBuffer({ sampleRate: 1000, channels: 1, targetMs: 0 });
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  buffer.push(1, Float32Array.from([0]), now - 40);
  buffer.push(2, Float32Array.from([0]), now - 20);
  buffer.push(3, Float32Array.from([0]), now);
  assert.ok(buffer.jitterMs > 0, 'jitter tracks arrival deviation');
  assert.strictEqual(buffer.metrics.pushed, 3);
}

{
  // Unrouted sources cannot grow without bound: the hard backlog cap trims the
  // oldest packets and keeps reported occupancy bounded.
  const buffer = new JitterBuffer({ sampleRate: 1000, channels: 1, targetMs: 20 });
  for (let i = 0; i < 3000; i++) buffer.push(i, Float32Array.from([1]));
  assert.ok(buffer.queuedFrames <= 1000, `backlog capped, got ${buffer.queuedFrames}`);
  assert.ok(buffer.metrics.overflowed > 0, 'trimmed packets are accounted');
  assert.ok(buffer.stats().occupancyMs <= 1000);
  close(buffer.pop(1), [1], 'timeline resumes at the oldest surviving packet');
}

{
  // sourceStats() exposes one entry per mixer source for the render loop.
  const mixer = new Mixer({ sampleRate: 1000, channels: 1, targetMs: 0 });
  mixer.addSource('a'); mixer.addSource('b');
  mixer.push('a', 1, Float32Array.from([0]));
  const stats = mixer.sourceStats();
  assert.deepStrictEqual([...stats.keys()].sort(), ['a', 'b']);
  assert.strictEqual(typeof stats.get('a').jitterMs, 'number');
}

console.log('audio-engine tests passed');
