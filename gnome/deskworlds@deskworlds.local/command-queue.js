// Bound WebKit IPC to one evaluation in flight. A slow frame keeps only the newest
// cursor and power state instead of building a backlog of stale pointer events.
export function createCommandQueue(schedule, evaluate) {
    let scheduled = false, busy = false, disposed = false;
    const pending = new Map();
    function flush() {
        scheduled = false;
        if (disposed || busy || !pending.size) return;
        const script = [...pending.values()].join(';');
        pending.clear();
        busy = true;
        evaluate(script, () => { busy = false; wake(); });
    }
    function wake() {
        if (!disposed && !busy && !scheduled && pending.size) {
            scheduled = true;
            schedule(flush);
        }
    }
    return {
        send(key, script) {
            if (disposed) return;
            pending.set(key, script);
            wake();
        },
        dispose() { disposed = true; pending.clear(); },
    };
}
