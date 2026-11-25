import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaybackQueue, MIN_RATE, MAX_RATE } from "../public/playback.js";

function setup() {
  const played = [];
  const queue = new PlaybackQueue({ play: (clip, rate) => played.push({ clip, rate }) });
  queue.enabled = true;
  return { queue, played };
}

test("plays clips one at a time in arrival order", () => {
  const { queue, played } = setup();
  queue.push("a");
  queue.push("b");
  queue.push("c");
  assert.deepEqual(played.map((p) => p.clip), ["a"]);
  queue.finished();
  queue.finished();
  assert.deepEqual(played.map((p) => p.clip), ["a", "b", "c"]);
});

test("ignores audio until the listener turns sound on", () => {
  const { queue, played } = setup();
  queue.enabled = false;
  queue.push("a");
  assert.equal(played.length, 0);
  assert.equal(queue.backlog, 0);
});

test("speeds up while behind, capped, and returns to normal once caught up", () => {
  const { queue } = setup();
  queue.push("playing");
  for (let i = 0; i < 10; i++) queue.push(`waiting ${i}`);
  assert.equal(queue.rate, MAX_RATE);
  while (queue.playing) queue.finished();
  assert.equal(queue.backlog, 0);
  for (let i = 0; i < 10; i++) {
    queue.push("one");
    queue.finished();
  }
  assert.equal(queue.rate, MIN_RATE);
});

test("stays at normal speed when keeping up", () => {
  const { queue, played } = setup();
  for (let i = 0; i < 20; i++) {
    queue.push(`clip ${i}`);
    queue.finished();
  }
  assert.equal(played.length, 20);
  assert.ok(played.every((p) => p.rate === MIN_RATE));
});

test("clearing (mute or language change) drops the backlog and resets speed", () => {
  const { queue, played } = setup();
  for (let i = 0; i < 5; i++) queue.push(`clip ${i}`);
  queue.clear();
  assert.equal(queue.backlog, 0);
  assert.equal(queue.rate, MIN_RATE);
  queue.push("fresh");
  assert.equal(played.at(-1).clip, "fresh");
});

// A speaker produces a 2 s clip every 1.8 s, slightly faster than real time, for
// 10 minutes. Without speed-up the listener would end up about a minute behind.
test("a listener who falls behind catches up instead of drifting further back", () => {
  const CLIP_SECONDS = 2;
  const ARRIVAL_SECONDS = 1.8;
  const queue = new PlaybackQueue({ play: () => {} });
  queue.enabled = true;
  let now = 0;
  let clipEnds = Infinity;
  let maxBacklog = 0;
  const origNext = queue.next.bind(queue);
  queue.next = () => {
    const wasPlaying = queue.playing;
    origNext();
    if (!wasPlaying && queue.playing) clipEnds = now + CLIP_SECONDS / queue.rate;
  };
  for (let arrival = 0; arrival < 600; arrival += ARRIVAL_SECONDS) {
    while (clipEnds <= arrival) {
      now = clipEnds;
      clipEnds = Infinity;
      queue.finished();
    }
    now = arrival;
    queue.push("clip");
    maxBacklog = Math.max(maxBacklog, queue.backlog);
  }
  assert.ok(maxBacklog <= 3, `backlog reached ${maxBacklog} clips`);
  assert.ok(queue.rate > MIN_RATE, "should be playing faster to keep up");
});
