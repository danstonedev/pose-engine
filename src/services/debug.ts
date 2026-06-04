/**
 * Minimal debug shim for the pose engine. Mirrors the small subset of the
 * body-chart debug API that pose modules (posedGeometry) call, gated by the
 * same `globalThis.__BODY_CHART_DEBUG__` flag so toggling debug in a host app
 * still controls engine-side logging. The richer body-chart debug API
 * (event ring buffer, WebGL memory, painter capture) stays in the app.
 */

function debugFlag(): boolean {
  const g = globalThis as { __BODY_CHART_DEBUG__?: boolean };
  return g.__BODY_CHART_DEBUG__ === true;
}

export function isBodyChartDebugEnabled(): boolean {
  return debugFlag();
}

export function bodyChartDebugLog(message: string, details?: unknown): void {
  if (!debugFlag()) return;
  if (details === undefined) console.debug(`[pose-engine] ${message}`);
  else console.debug(`[pose-engine] ${message}`, details);
}

const _sampleCounts: Record<string, number> = {};

export function shouldSampleBodyChartDebug(key: string, maxSamples: number): boolean {
  if (!debugFlag()) return false;
  const current = _sampleCounts[key] ?? 0;
  if (current >= maxSamples) return false;
  _sampleCounts[key] = current + 1;
  return true;
}
