// Pure geometry shared by presentation and input. All coordinates are logical pixels;
// the WebView translates the normalized pointer into its own CSS coordinates.
export function coverGeometry(sourceWidth, sourceHeight, width, height) {
    if (![sourceWidth, sourceHeight, width, height].every(v => Number.isFinite(v) && v > 0))
        return null;
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    return {width: sourceWidth * scale, height: sourceHeight * scale,
        x: (width - sourceWidth * scale) / 2, y: (height - sourceHeight * scale) / 2};
}

export function desktopPointer(monitors, rates, x, y, sourceWidth, sourceHeight) {
    const index = monitors.findIndex(m => x >= m.x && y >= m.y &&
        x < m.x + m.width && y < m.y + m.height);
    if (index < 0 || !(rates[index] > 0)) return null;
    const m = monitors[index];
    const cover = coverGeometry(sourceWidth, sourceHeight, m.width, m.height);
    if (!cover) return null;
    return [(x - m.x - cover.x) / cover.width, (y - m.y - cover.y) / cover.height];
}

// Union of clipped rectangles: tiled windows count together, overlaps count once.
export function coveredFraction(monitor, rectangles) {
    if (!(monitor.width > 0 && monitor.height > 0)) return 1;
    const clipped = rectangles.map(r => ({
        left: Math.max(r.x, monitor.x), right: Math.min(r.x + r.width, monitor.x + monitor.width),
        top: Math.max(r.y, monitor.y), bottom: Math.min(r.y + r.height, monitor.y + monitor.height),
    })).filter(r => r.right > r.left && r.bottom > r.top);
    const edges = [...new Set(clipped.flatMap(r => [r.left, r.right]))].sort((a, b) => a - b);
    let area = 0;
    for (let i = 1; i < edges.length; i++) {
        const intervals = clipped.filter(r => r.left < edges[i] && r.right > edges[i - 1])
            .map(r => [r.top, r.bottom]).sort((a, b) => a[0] - b[0]);
        let height = 0, bottom = -Infinity;
        for (const [top, end] of intervals) {
            height += Math.max(0, end - Math.max(top, bottom));
            bottom = Math.max(bottom, end);
        }
        area += (edges[i] - edges[i - 1]) * height;
    }
    return Math.min(1, area / (monitor.width * monitor.height));
}

export function desktopRates(monitors, rectangles, {paused = false, saver = false,
    locked = false, overview = false, battery = false} = {}) {
    return monitors.map(m => {
        if (paused || saver || locked) return 0;
        const covered = overview ? 0 : coveredFraction(m, rectangles);
        return covered > 0.85 ? 0 : covered > 0.6 ? 15 : battery ? 20 : 30;
    });
}

export function pollInterval(rate, live = true) {
    return live && rate > 0 ? Math.ceil(1000 / rate) : 500;
}
