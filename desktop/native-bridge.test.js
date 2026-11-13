const assert = require('assert');
const { AudioBlockFifo } = require('./native-bridge');

{
  const fifo = new AudioBlockFifo({ capacityBlocks: 3 });
  fifo.push(Buffer.from([1]), 480);
  fifo.push(Buffer.from([2]), 480);
  assert.strictEqual(fifo.length, 2);
  assert.strictEqual(fifo.queuedFrames, 960);
  assert.strictEqual(fifo.highWatermarkBlocks, 2);
  const first = fifo.shift();
  assert.deepStrictEqual(first.buffer, Buffer.from([1]));
  assert.strictEqual(first.frames, 480);
  assert.strictEqual(fifo.queuedFrames, 480);
  assert.strictEqual(fifo.length, 1);
}

{
  // Overflow drops the oldest block (live audio must not accumulate latency)
  // but every dropped block and frame is accounted for.
  const fifo = new AudioBlockFifo({ capacityBlocks: 2 });
  fifo.push(Buffer.from([1]), 480);
  fifo.push(Buffer.from([2]), 480);
  fifo.push(Buffer.from([3]), 480);
  assert.strictEqual(fifo.length, 2, 'capacity is enforced');
  assert.strictEqual(fifo.droppedBlocks, 1);
  assert.strictEqual(fifo.droppedFrames, 480);
  assert.strictEqual(fifo.queuedFrames, 960);
  assert.deepStrictEqual(fifo.shift().buffer, Buffer.from([2]), 'oldest block is dropped first');
  assert.deepStrictEqual(fifo.shift().buffer, Buffer.from([3]));
  assert.strictEqual(fifo.shift(), null);
  assert.strictEqual(fifo.queuedFrames, 0);
}

{
  const fifo = new AudioBlockFifo();
  assert.strictEqual(fifo.capacity, 48, 'default capacity absorbs event-loop jitter');
  fifo.push(Buffer.alloc(4), 480);
  fifo.clear();
  assert.strictEqual(fifo.length, 0);
  assert.strictEqual(fifo.queuedFrames, 0);
  assert.strictEqual(fifo.droppedBlocks, 0, 'clear() is not a drop');
}

console.log('native-bridge tests passed');
