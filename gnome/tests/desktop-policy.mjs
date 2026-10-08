import assert from 'node:assert/strict';
import {coverGeometry, desktopPointer, coveredFraction, desktopRates, pollInterval}
    from '../deskworlds@deskworlds.local/desktop-policy.js';
import {createCommandQueue} from '../deskworlds@deskworlds.local/command-queue.js';

const monitors = [
    {x: -1920, y: 0, width: 1920, height: 1200},
    {x: 0, y: 120, width: 1920, height: 1080},
    {x: -789, y: 1200, width: 1536, height: 960},
];
assert.deepEqual(coverGeometry(1536, 960, 1920, 1080), {x: 0, y: -60, width: 1920, height: 1200});
assert.deepEqual(coverGeometry(1536, 960, 1080, 1920), {x: -996, y: 0, width: 3072, height: 1920});
assert.equal(coverGeometry(0, 960, 1920, 1080), null);
assert.equal(coverGeometry(NaN, 960, 1920, 1080), null);
for (const m of monitors) {
    assert.deepEqual(desktopPointer(monitors, [30, 30, 30], m.x + m.width / 2,
        m.y + m.height / 2, 1536, 960), [0.5, 0.5]);
}
assert.deepEqual(desktopPointer(monitors, [30, 30, 30], 0, 120, 1536, 960), [0, 0.05]);
assert.equal(desktopPointer(monitors, [30, 0, 30], 100, 200, 1536, 960), null);
assert.equal(desktopPointer(monitors, [30, 30, 30], 1920, 500, 1536, 960), null);
assert.equal(desktopPointer(monitors, [30, 30, 30], 100, 0, 1536, 960), null);

const m = {x: 0, y: 0, width: 100, height: 100};
const tile = (x, width) => ({x, y: 0, width, height: 100});
assert.equal(coveredFraction(m, []), 0);
assert.equal(coveredFraction(m, [tile(-100, 200)]), 1);
assert.equal(coveredFraction(m, [tile(0, 50), tile(50, 50)]), 1);
assert.equal(coveredFraction(m, [tile(0, 50), tile(25, 50)]), 0.75);
assert.equal(coveredFraction(m, [tile(0, 50), tile(0, 50)]), 0.5);
assert.equal(coveredFraction(m, [tile(100, 50)]), 0);
assert.deepEqual(desktopRates(monitors, [monitors[2]]), [30, 30, 0], 'Covered primary must not stop external desktops');
assert.deepEqual(desktopRates(monitors, monitors), [0, 0, 0]);
assert.deepEqual(desktopRates([m], [tile(0, 75)]), [15]);
assert.deepEqual(desktopRates([m], [tile(0, 86)]), [0]);
assert.deepEqual(desktopRates(monitors, [], {battery: true}), [20, 20, 20]);
assert.deepEqual(desktopRates(monitors, monitors, {overview: true}), [30, 30, 30]);
for (const option of ['paused', 'saver', 'locked'])
    assert.deepEqual(desktopRates(monitors, [], {[option]: true, overview: true}), [0, 0, 0]);
assert.equal(pollInterval(30), 34);
assert.equal(pollInterval(20), 50);
assert.equal(pollInterval(15), 67);
assert.equal(pollInterval(0), 500);
assert.equal(pollInterval(30, false), 500);

// Check the rectangle union against exact integer pixel coverage for many layouts.
let seed = 42;
const random = () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32;
for (let sample = 0; sample < 100; sample++) {
    const rectangles = Array.from({length: 6}, () => ({x: Math.floor(random() * 20) - 5,
        y: Math.floor(random() * 20) - 5, width: Math.floor(random() * 10), height: Math.floor(random() * 10)}));
    let pixels = 0;
    for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++)
        if (rectangles.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) pixels++;
    assert.equal(coveredFraction({x: 0, y: 0, width: 10, height: 10}, rectangles), pixels / 100);
}

const scheduled = [], evaluations = [];
let complete;
const queue = createCommandQueue(fn => scheduled.push(fn), (script, done) => {
    evaluations.push(script); complete = done;
});
queue.send('state', 'rate(30)');
queue.send('pointer', 'pointer(1)');
queue.send('pointer', 'pointer(2)');
assert.equal(scheduled.length, 1);
scheduled.shift()();
assert.deepEqual(evaluations, ['rate(30);pointer(2)']);
for (let i = 0; i < 1000; i++) queue.send('pointer', `pointer(${i})`);
queue.send('state', 'rate(0)');
queue.send('pointer', 'out()');
assert.equal(scheduled.length, 0, 'A blocked renderer must not accumulate evaluations');
complete();
assert.equal(scheduled.length, 1);
scheduled.shift()();
assert.deepEqual(evaluations, ['rate(30);pointer(2)', 'out();rate(0)']);
queue.send('feed', 'feed()');
queue.dispose(); complete();
queue.send('pointer', 'pointer(0)');
assert.equal(scheduled.length, 0);
console.log('PASS: mixed-size monitors, portrait crop, normalized pointer, tiled/overlapping coverage, power policy and bounded renderer IPC');
