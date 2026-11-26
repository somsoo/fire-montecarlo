/**
 * 파이어족(FIRE) 몬테카를로 은퇴 생존확률 시뮬레이터 — Web Worker (montecarlo-worker.js)
 *
 * 심화 경로(/kr/fire-montecarlo/stress-test/)에서 10,000회 정밀 시뮬레이션,
 * 대폭락(-30%/-40%) × 고물가(연 5%) 복합 매트릭스, 안전 인출률(3.0%~5.0%) 생존곡선을
 * 브라우저 UI 멈춤 없이 백그라운드 스레드에서 계산한다.
 */
/* global importScripts, MonteCarloEngine */

importScripts('./montecarlo-engine.js');

self.onmessage = function (event) {
  var data = event.data || {};
  var requestId = data.requestId || 0;
  var type = data.type || 'RUN_STRESS_SUITE';
  var params = data.params || {};
  var options = data.options || {};

  var startedAt = (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();

  try {
    if (type === 'RUN_SIMULATION') {
      var simResult = MonteCarloEngine.runSimulation(params, {
        iterations: options.iterations || 10000,
        firstYearShock: typeof options.firstYearShock === 'number' ? options.firstYearShock : null,
        seed: typeof options.seed === 'number' ? options.seed : null
      });

      self.postMessage({
        ok: true,
        requestId: requestId,
        type: type,
        result: simResult
      });
      return;
    }

    // 기본: 심화 리포트용 10,000회 풀 패키지 연산 (RUN_STRESS_SUITE)
    var iterations = options.iterations || 10000;
    var seed = typeof options.seed === 'number' ? options.seed : null;

    var base10k = MonteCarloEngine.runSimulation(params, {
      iterations: iterations,
      firstYearShock: null,
      seed: seed
    });

    var shock30 = MonteCarloEngine.runSimulation(params, {
      iterations: iterations,
      firstYearShock: -0.30,
      seed: seed
    });

    var stressMatrix = MonteCarloEngine.runStressMatrix(params, {
      iterations: iterations,
      seed: seed || 20261125
    });

    var withdrawalCurve = MonteCarloEngine.runWithdrawalCurve(params, {
      iterations: Math.min(iterations, 10000),
      rates: [3.0, 3.5, 4.0, 4.5, 5.0],
      seed: seed || 20261125
    });

    var finishedAt = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    self.postMessage({
      ok: true,
      requestId: requestId,
      type: 'RUN_STRESS_SUITE',
      totalElapsedMs: Number((finishedAt - startedAt).toFixed(2)),
      result: {
        base10k: base10k,
        shock30: shock30,
        stressMatrix: stressMatrix,
        withdrawalCurve: withdrawalCurve
      }
    });
  } catch (err) {
    self.postMessage({
      ok: false,
      requestId: requestId,
      error: err && err.message ? err.message : String(err)
    });
  }
};
