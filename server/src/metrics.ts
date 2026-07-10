/** Tiny dependency-free Prometheus registry for operator diagnostics. Labels
 * are intentionally bounded to known route/method/status values. */

const httpCounts = new Map<string, number>();
let httpDurationMsTotal = 0;
let httpDurationCount = 0;
const domainCounts = new Map<string, number>();

function inc(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function recordHttp(method: string, route: string, status: number, durationMs: number): void {
  inc(httpCounts, `${method}\0${route}\0${status}`);
  httpDurationMsTotal += Math.max(0, durationMs);
  httpDurationCount += 1;
}

export function recordDomainEvent(name: string, by = 1): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) return;
  inc(domainCounts, name, by);
}

export function renderMetrics(): string {
  const lines = [
    '# HELP arix_http_requests_total Total HTTP requests.',
    '# TYPE arix_http_requests_total counter',
  ];
  for (const [key, value] of [...httpCounts].sort(([a], [b]) => a.localeCompare(b))) {
    const [method, route, status] = key.split('\0') as [string, string, string];
    lines.push(
      `arix_http_requests_total{method="${esc(method)}",route="${esc(route)}",status="${esc(status)}"} ${value}`,
    );
  }
  lines.push(
    '# HELP arix_http_request_duration_ms_sum Sum of HTTP request duration in milliseconds.',
    '# TYPE arix_http_request_duration_ms_sum counter',
    `arix_http_request_duration_ms_sum ${httpDurationMsTotal}`,
    '# HELP arix_http_request_duration_ms_count Number of timed HTTP requests.',
    '# TYPE arix_http_request_duration_ms_count counter',
    `arix_http_request_duration_ms_count ${httpDurationCount}`,
    '# HELP arix_domain_events_total Bounded application event counters.',
    '# TYPE arix_domain_events_total counter',
  );
  for (const [name, value] of [...domainCounts].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`arix_domain_events_total{name="${esc(name)}"} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}
