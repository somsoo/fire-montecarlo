/**
 * 파이어족(FIRE) 몬테카를로 은퇴 생존확률 시뮬레이터 — 수학 코어 엔진 (montecarlo-engine.js)
 *
 * [설계 원칙]
 * 1. 에버그린: 국민연금·세법·건보료 등 변동 법령 하드코딩 0건.
 *    은퇴 후 순인출액 = max(0, 은퇴 후 월 생활비 - 추가 고정수입) * 12 * (1 + 물가상승률)^t
 * 2. 고성능 로컬 연산: Float64Array 연도별 연속 버퍼를 사용하여 2,000회 연산 50ms 이내 보장.
 * 3. 환경 호환성: 브라우저 메인 스레드(window), Web Worker(self), Node.js 검증 환경 공용 모듈.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MonteCarloEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 기본 입력 파라미터 (단위: 금액=만원, 연령=세, 비율=%) */
  var DEFAULT_PARAMS = Object.freeze({
    currentNetWorth: 30000,     // 현재 순자산 (3억 원)
    monthlySaving: 250,         // 은퇴 전 월 저축액 (250만 원)
    currentAge: 35,             // 현재 나이 (세)
    retireAge: 45,              // 목표 은퇴 나이 (세)
    targetAge: 90,              // 목표 기대수명 (세)
    monthlyExpense: 250,        // 은퇴 후 월 생활비 - 현재가치 기준 (250만 원)
    monthlyExtraIncome: 0,      // 은퇴 후 예상 추가 고정수입 - 선택 입력 (0만 원)
    expectedReturn: 7.0,        // 포트폴리오 연 기대수익률 (%)
    volatility: 12.0,           // 포트폴리오 연간 변동성/표준편차 (%)
    inflation: 2.5              // 예상 연간 물가상승률 (%)
  });

  /** 자산배분 성향별 참고 프리셋 (법령 무관 포트폴리오 통계 예시) */
  var PORTFOLIO_PRESETS = Object.freeze({
    conservative: {
      id: 'conservative',
      name: '안정형 (예금·채권 중심)',
      expectedReturn: 4.5,
      volatility: 6.0
    },
    balanced: {
      id: 'balanced',
      name: '균형형 (주식·채권 60:40)',
      expectedReturn: 7.0,
      volatility: 12.0
    },
    aggressive: {
      id: 'aggressive',
      name: '성장형 (글로벌 주식 중심)',
      expectedReturn: 9.0,
      volatility: 17.5
    }
  });

  /**
   * 재현 가능한 검증 및 동일 난수 경로 비교용 시드 PRNG (Mulberry32)
   * @param {number} seed 32비트 정수 시드
   * @returns {function(): number} [0, 1) 균등난수 생성 함수
   */
  function createSeededRandom(seed) {
    var state = (seed >>> 0) || 1;
    return function () {
      state = (state + 0x6D2B79F5) | 0;
      var t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 박스-뮬러 변환 (Box-Muller Transform) 표준정규난수 생성기 Z ~ N(0, 1)
   * 한 번의 로그·삼각함수 연산으로 독립 정규난수 2개를 생성하여 캐싱함.
   * @param {function(): number} [uniformRng] 균등난수 함수 (기본 Math.random)
   * @returns {function(): number} 표준정규난수 반환 함수
   */
  function createNormalGenerator(uniformRng) {
    var rng = typeof uniformRng === 'function' ? uniformRng : Math.random;
    var hasSpare = false;
    var spare = 0.0;

    return function nextStandardNormal() {
      if (hasSpare) {
        hasSpare = false;
        return spare;
      }
      var u1 = 1.0 - rng(); // (0, 1] 구간 보장 (log(0) 방지)
      var u2 = rng();
      if (u1 <= 1e-15) {
        u1 = 1e-15;
      }
      var mag = Math.sqrt(-2.0 * Math.log(u1));
      var angle = 2.0 * Math.PI * u2;
      spare = mag * Math.sin(angle);
      hasSpare = true;
      return mag * Math.cos(angle);
    };
  }

  /**
   * 숫자 안전 파싱 및 범위 제한
   */
  function clampNumber(val, min, max, fallback) {
    var num = Number(val);
    if (!Number.isFinite(num)) {
      return fallback;
    }
    if (num < min) return min;
    if (num > max) return max;
    return num;
  }

  /**
   * 입력 파라미터 정규화 및 연령 논리 순서 보정
   * @param {Object} raw 사용자 입력 객체
   * @returns {Object} 정규화된 파라미터 객체
   */
  function sanitizeParams(raw) {
    var src = raw || {};
    var currentAge = Math.round(clampNumber(src.currentAge, 18, 85, DEFAULT_PARAMS.currentAge));
    var retireAge = Math.round(clampNumber(src.retireAge, currentAge, 90, Math.max(currentAge, DEFAULT_PARAMS.retireAge)));
    var targetAge = Math.round(clampNumber(src.targetAge, retireAge + 1, 110, Math.max(retireAge + 5, DEFAULT_PARAMS.targetAge)));

    return {
      currentNetWorth: clampNumber(src.currentNetWorth, 0, 10000000, DEFAULT_PARAMS.currentNetWorth),
      monthlySaving: clampNumber(src.monthlySaving, 0, 100000, DEFAULT_PARAMS.monthlySaving),
      currentAge: currentAge,
      retireAge: retireAge,
      targetAge: targetAge,
      monthlyExpense: clampNumber(src.monthlyExpense, 0, 100000, DEFAULT_PARAMS.monthlyExpense),
      monthlyExtraIncome: clampNumber(src.monthlyExtraIncome, 0, 100000, DEFAULT_PARAMS.monthlyExtraIncome),
      expectedReturn: clampNumber(src.expectedReturn, -10.0, 30.0, DEFAULT_PARAMS.expectedReturn),
      volatility: clampNumber(src.volatility, 0.0, 60.0, DEFAULT_PARAMS.volatility),
      inflation: clampNumber(src.inflation, -2.0, 20.0, DEFAULT_PARAMS.inflation)
    };
  }

  /**
   * 생존확률(%)에 따른 4단계 등급 판정
   * @param {number} survivalRate 생존확률 (0 ~ 100)
   */
  function getGradeInfo(survivalRate) {
    var rate = clampNumber(survivalRate, 0, 100, 0);
    if (rate >= 90) {
      return {
        code: 'SAFE',
        label: '안정',
        fullLabel: '안정 등급',
        badgeClass: 'grade-safe',
        color: '#059669',
        description: '시장 변동성과 인플레이션을 견디며 목표 기대수명까지 자산이 유지될 확률이 매우 높습니다.'
      };
    }
    if (rate >= 75) {
      return {
        code: 'MODERATE',
        label: '양호',
        fullLabel: '양호 등급',
        badgeClass: 'grade-moderate',
        color: '#2563eb',
        description: '대체로 안정적이나 은퇴 초기 하락장 발생 시 지출 유연화가 필요할 수 있습니다.'
      };
    }
    if (rate >= 50) {
      return {
        code: 'CAUTION',
        label: '주의',
        fullLabel: '주의 등급',
        badgeClass: 'grade-caution',
        color: '#d97706',
        description: '수익률 순서 위험에 노출되어 있습니다. 은퇴 시점·인출률·저축액 조정을 권장합니다.'
      };
    }
    return {
      code: 'RISK',
      label: '위험',
      fullLabel: '위험 등급',
      badgeClass: 'grade-risk',
      color: '#dc2626',
      description: '기대수명 이전 자산 고갈 가능성이 높습니다. 목표 은퇴 연령 또는 월 지출 계획을 재점검하세요.'
    };
  }

  /**
   * 정렬된 Float64Array 슬라이스에서 선형 보간 백분위수 추출
   * @param {Float64Array} sorted 오름차순 정렬된 배열
   * @param {number} p 백분위 (0.0 ~ 1.0)
   */
  function pickPercentile(sorted, p) {
    var len = sorted.length;
    if (len === 0) return 0;
    if (len === 1) return sorted[0];
    var idx = p * (len - 1);
    var lo = Math.floor(idx);
    var hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    var weight = idx - lo;
    return sorted[lo] * (1 - weight) + sorted[hi] * weight;
  }

  /**
   * 몬테카를로 은퇴 시뮬레이션 실행 코어
   * @param {Object} rawParams 사용자 입력값
   * @param {Object} [options] 실행 옵션
   * @param {number} [options.iterations=2000] 시뮬레이션 횟수 (기본 2,000 / 심화 10,000)
   * @param {number|null} [options.firstYearShock=null] 은퇴 첫해 강제 수익률 (예: -0.30 = -30% 폭락)
   * @param {number|null} [options.seed=null] 재현성 검증용 정수 시드 (미지정 시 Math.random)
   * @param {boolean} [options.inflationAdjustedSaving=true] 은퇴 전 저축액 물가연동 여부
   */
  function runSimulation(rawParams, options) {
    var startPerf = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    var opts = options || {};
    var params = sanitizeParams(rawParams);
    var iterations = Math.round(clampNumber(opts.iterations, 100, 50000, 2000));
    var hasFirstYearShock = typeof opts.firstYearShock === 'number' && Number.isFinite(opts.firstYearShock);
    var firstYearShock = hasFirstYearShock ? Math.max(-0.95, opts.firstYearShock) : null;
    var inflationAdjustedSaving = opts.inflationAdjustedSaving !== false;

    var uniformRng = (typeof opts.seed === 'number' && Number.isFinite(opts.seed))
      ? createSeededRandom(opts.seed)
      : Math.random;
    var nextZ = createNormalGenerator(uniformRng);

    var years = params.targetAge - params.currentAge; // 총 시뮬레이션 연수
    var stepCount = years + 1;                        // 연령 포인트 수
    var retireStep = params.retireAge - params.currentAge;

    var mu = params.expectedReturn / 100.0;
    var sigma = params.volatility / 100.0;
    var inf = params.inflation / 100.0;

    var baseAnnualSaving = params.monthlySaving * 12.0;
    var netMonthlyWithdrawal = Math.max(0.0, params.monthlyExpense - params.monthlyExtraIncome);
    var baseAnnualWithdrawal = netMonthlyWithdrawal * 12.0;

    // 연도별 물가계수 및 현금흐름 사전 계산 (반복문 내부 Math.pow 제거)
    var inflationFactors = new Float64Array(stepCount);
    var annualCashflows = new Float64Array(years);
    for (var s = 0; s < stepCount; s++) {
      var factor = Math.pow(1.0 + inf, s);
      inflationFactors[s] = factor > 1e-6 ? factor : 1e-6;
      if (s < years) {
        if (s < retireStep) {
          annualCashflows[s] = inflationAdjustedSaving ? (baseAnnualSaving * factor) : baseAnnualSaving;
        } else {
          annualCashflows[s] = baseAnnualWithdrawal * factor;
        }
      }
    }

    // 연도 우선(Year-Major) 연속 버퍼: matrix[step * iterations + k]
    var matrix = new Float64Array(stepCount * iterations);
    var initialWealth = params.currentNetWorth;
    for (var i = 0; i < iterations; i++) {
      matrix[i] = initialWealth;
    }

    // 회차별 고갈 여부 추적용 배열 (순인출액 0원 엣지케이스 대응 포함)
    var survivedFlags = new Uint8Array(iterations);
    survivedFlags.fill(1);

    for (var t = 0; t < years; t++) {
      var currRowOffset = t * iterations;
      var nextRowOffset = (t + 1) * iterations;
      var isAccumulation = t < retireStep;
      var isFirstRetireYear = (t === retireStep);
      var cashflow = annualCashflows[t];

      for (var k = 0; k < iterations; k++) {
        var w = matrix[currRowOffset + k];
        var annualReturn;

        if (isFirstRetireYear && hasFirstYearShock) {
          annualReturn = firstYearShock;
        } else {
          annualReturn = mu + sigma * nextZ();
          if (annualReturn < -0.99) {
            annualReturn = -0.99; // 비레버리지 포트폴리오 원금 초과 손실 방지
          }
        }

        var nextW;
        if (isAccumulation) {
          nextW = w * (1.0 + annualReturn) + cashflow;
          if (nextW < 0.0) nextW = 0.0;
        } else {
          if (cashflow <= 0.0) {
            // 추가 고정수입이 월 생활비 이상인 경우 인출 없음
            nextW = w > 0.0 ? w * (1.0 + annualReturn) : 0.0;
          } else if (w <= cashflow) {
            // 해당 연도 생활비를 충당하지 못해 자산 고갈
            nextW = 0.0;
            survivedFlags[k] = 0;
          } else {
            nextW = (w - cashflow) * (1.0 + annualReturn);
            if (nextW <= 0.0) {
              nextW = 0.0;
              survivedFlags[k] = 0;
            }
          }
        }

        matrix[nextRowOffset + k] = nextW;
      }
    }

    // 생존 횟수 집계 (순인출액 > 0이면 최종 잔액 > 0과 동일)
    var survivedCount = 0;
    var lastRowOffset = years * iterations;
    for (var m = 0; m < iterations; m++) {
      if (baseAnnualWithdrawal > 0.0) {
        if (matrix[lastRowOffset + m] > 0.0 && survivedFlags[m] === 1) {
          survivedCount++;
        }
      } else {
        // 순인출액이 0원(고정수입 >= 생활비)이면 고갈되지 않음
        if (survivedFlags[m] === 1) {
          survivedCount++;
        }
      }
    }

    var survivalRate = (survivedCount / iterations) * 100.0;

    // 연도별 연령 배열 및 백분위수(명목 / 현재가치 환산) 추출
    var ages = new Array(stepCount);
    var nominal = {
      p10: new Array(stepCount),
      p25: new Array(stepCount),
      p50: new Array(stepCount),
      p75: new Array(stepCount),
      p90: new Array(stepCount)
    };
    var real = {
      p10: new Array(stepCount),
      p25: new Array(stepCount),
      p50: new Array(stepCount),
      p75: new Array(stepCount),
      p90: new Array(stepCount)
    };

    var medianDepletionAge = null;
    var p25DepletionAge = null;
    var p10DepletionAge = null;

    for (var step = 0; step < stepCount; step++) {
      var age = params.currentAge + step;
      ages[step] = age;

      var slice = matrix.subarray(step * iterations, (step + 1) * iterations);
      slice.sort(); // Float64Array 네이티브 고속 오름차순 정렬

      var v10 = pickPercentile(slice, 0.10);
      var v25 = pickPercentile(slice, 0.25);
      var v50 = pickPercentile(slice, 0.50);
      var v75 = pickPercentile(slice, 0.75);
      var v90 = pickPercentile(slice, 0.90);

      nominal.p10[step] = Math.round(v10);
      nominal.p25[step] = Math.round(v25);
      nominal.p50[step] = Math.round(v50);
      nominal.p75[step] = Math.round(v75);
      nominal.p90[step] = Math.round(v90);

      var deflator = inflationFactors[step];
      real.p10[step] = Math.round(v10 / deflator);
      real.p25[step] = Math.round(v25 / deflator);
      real.p50[step] = Math.round(v50 / deflator);
      real.p75[step] = Math.round(v75 / deflator);
      real.p90[step] = Math.round(v90 / deflator);

      if (step > retireStep && baseAnnualWithdrawal > 0) {
        if (medianDepletionAge === null && v50 <= 0.0) medianDepletionAge = age;
        if (p25DepletionAge === null && v25 <= 0.0) p25DepletionAge = age;
        if (p10DepletionAge === null && v10 <= 0.0) p10DepletionAge = age;
      }
    }

    // 은퇴 시점 중앙값(P50) 자산 및 초기 인출률(%) 산출
    var retireMedianNominal = nominal.p50[retireStep];
    var retireMedianReal = real.p50[retireStep];
    var firstRetireWithdrawalNominal = baseAnnualWithdrawal * inflationFactors[retireStep];

    var initialWithdrawalRate = 0.0;
    if (firstRetireWithdrawalNominal > 0.0) {
      if (retireMedianNominal > 0.0) {
        initialWithdrawalRate = (firstRetireWithdrawalNominal / retireMedianNominal) * 100.0;
      } else {
        initialWithdrawalRate = 100.0;
      }
    }

    var endPerf = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    return {
      params: params,
      iterations: iterations,
      firstYearShock: firstYearShock,
      elapsedMs: Number((endPerf - startPerf).toFixed(2)),
      ages: ages,
      retireStep: retireStep,
      survivalRate: Number(survivalRate.toFixed(1)),
      survivedCount: survivedCount,
      grade: getGradeInfo(survivalRate),
      initialWithdrawalRate: Number(initialWithdrawalRate.toFixed(2)),
      retireMedianNominal: retireMedianNominal,
      retireMedianReal: retireMedianReal,
      finalMedianNominal: nominal.p50[years],
      finalMedianReal: real.p50[years],
      medianDepletionAge: medianDepletionAge,
      p25DepletionAge: p25DepletionAge,
      p10DepletionAge: p10DepletionAge,
      percentilesNominal: nominal,
      percentilesReal: real
    };
  }

  /**
   * 심화 리포트용 복합 스트레스 매트릭스 산출
   * (평시 / 첫해 -30% 폭락 / 첫해 -40% 대폭락) × (기본 물가 / 연 5% 고물가)
   * @param {Object} rawParams 입력 파라미터
   * @param {Object} [options] { iterations: 10000, seed }
   */
  function runStressMatrix(rawParams, options) {
    var opts = options || {};
    var params = sanitizeParams(rawParams);
    var iterations = Math.round(clampNumber(opts.iterations, 500, 20000, 10000));
    var highInflation = Math.max(params.inflation, 5.0);
    var baseSeed = (typeof opts.seed === 'number' && Number.isFinite(opts.seed))
      ? opts.seed
      : 20261125;

    var scenarios = [
      { id: 'base_normal', label: '평시 시장 × 기본 물가(' + params.inflation + '%)', shock: null, inflation: params.inflation },
      { id: 'base_high_inf', label: '평시 시장 × 고물가(연 ' + highInflation.toFixed(1) + '%)', shock: null, inflation: highInflation },
      { id: 'crash30_normal', label: '은퇴 첫해 -30% 폭락 × 기본 물가(' + params.inflation + '%)', shock: -0.30, inflation: params.inflation },
      { id: 'crash30_high_inf', label: '은퇴 첫해 -30% 폭락 × 고물가(연 ' + highInflation.toFixed(1) + '%)', shock: -0.30, inflation: highInflation },
      { id: 'crash40_normal', label: '은퇴 첫해 -40% 대폭락 × 기본 물가(' + params.inflation + '%)', shock: -0.40, inflation: params.inflation },
      { id: 'crash40_high_inf', label: '은퇴 첫해 -40% 대폭락 × 고물가(연 ' + highInflation.toFixed(1) + '%)', shock: -0.40, inflation: highInflation }
    ];

    return scenarios.map(function (sc) {
      var scenarioParams = Object.assign({}, params, { inflation: sc.inflation });
      var res = runSimulation(scenarioParams, {
        iterations: iterations,
        firstYearShock: sc.shock,
        seed: baseSeed
      });
      return {
        id: sc.id,
        label: sc.label,
        shockPercent: sc.shock === null ? 0 : Math.round(sc.shock * 100),
        inflation: sc.inflation,
        survivalRate: res.survivalRate,
        grade: res.grade,
        medianDepletionAge: res.medianDepletionAge,
        p25DepletionAge: res.p25DepletionAge,
        p10DepletionAge: res.p10DepletionAge,
        finalMedianReal: res.finalMedianReal,
        finalMedianNominal: res.finalMedianNominal
      };
    });
  }

  /**
   * 심화 리포트용 안전 인출률(3.0% ~ 5.0%, 0.5%p 간격)별 생존곡선 산출
   * 은퇴 시점 중앙값 순자산(현재가치 환산)을 기준으로 각 초기 인출률을 적용했을 때
   * 연령별 생존 유지 비율(%) 곡선과 최종 생존확률을 계산한다.
   * @param {Object} rawParams 입력 파라미터
   * @param {Object} [options] { iterations: 5000, rates: [3.0, 3.5, 4.0, 4.5, 5.0], seed }
   */
  function runWithdrawalCurve(rawParams, options) {
    var opts = options || {};
    var params = sanitizeParams(rawParams);
    var iterations = Math.round(clampNumber(opts.iterations, 500, 20000, 5000));
    var rates = Array.isArray(opts.rates) && opts.rates.length > 0
      ? opts.rates
      : [3.0, 3.5, 4.0, 4.5, 5.0];
    var baseSeed = (typeof opts.seed === 'number' && Number.isFinite(opts.seed))
      ? opts.seed
      : 20261125;

    // 기준 은퇴 시점 예상 순자산(현재가치) 확보
    var baseline = runSimulation(params, { iterations: Math.min(iterations, 2000), seed: baseSeed });
    var retireRealAsset = Math.max(100, baseline.retireMedianReal); // 최소 100만원 방어

    var retireAges = [];
    for (var a = params.retireAge; a <= params.targetAge; a++) {
      retireAges.push(a);
    }
    var retireYears = params.targetAge - params.retireAge;
    var mu = params.expectedReturn / 100.0;
    var sigma = params.volatility / 100.0;
    var inf = params.inflation / 100.0;

    var curves = rates.map(function (ratePct) {
      var rng = createSeededRandom(baseSeed);
      var nextZ = createNormalGenerator(rng);
      var rate = ratePct / 100.0;

      // 은퇴 시점 자산 100 단위로 정규화하여 순수 인출률 생존곡선 계산
      var aliveCounts = new Int32Array(retireYears + 1);
      aliveCounts[0] = iterations;

      for (var k = 0; k < iterations; k++) {
        var w = 1.0;
        var alive = true;
        for (var y = 0; y < retireYears; y++) {
          if (!alive) break;
          var withdrawal = rate * Math.pow(1.0 + inf, y);
          if (w <= withdrawal) {
            alive = false;
            break;
          }
          var r = mu + sigma * nextZ();
          if (r < -0.99) r = -0.99;
          w = (w - withdrawal) * (1.0 + r);
          if (w <= 0.0) {
            alive = false;
            break;
          }
          aliveCounts[y + 1]++;
        }
      }

      var survivalByAge = new Array(retireYears + 1);
      for (var s = 0; s <= retireYears; s++) {
        survivalByAge[s] = Number(((aliveCounts[s] / iterations) * 100.0).toFixed(1));
      }

      var impliedNetMonthlyReal = Math.round((retireRealAsset * rate) / 12.0);
      var impliedTotalMonthlyReal = impliedNetMonthlyReal + Math.round(params.monthlyExtraIncome);
      var finalSurvival = survivalByAge[retireYears];

      return {
        ratePct: ratePct,
        impliedNetMonthlyReal: impliedNetMonthlyReal,
        impliedTotalMonthlyReal: impliedTotalMonthlyReal,
        finalSurvivalRate: finalSurvival,
        grade: getGradeInfo(finalSurvival),
        survivalByAge: survivalByAge
      };
    });

    return {
      retireAges: retireAges,
      retireMedianReal: baseline.retireMedianReal,
      curves: curves
    };
  }

  return {
    DEFAULT_PARAMS: DEFAULT_PARAMS,
    PORTFOLIO_PRESETS: PORTFOLIO_PRESETS,
    createSeededRandom: createSeededRandom,
    createNormalGenerator: createNormalGenerator,
    sanitizeParams: sanitizeParams,
    getGradeInfo: getGradeInfo,
    runSimulation: runSimulation,
    runStressMatrix: runStressMatrix,
    runWithdrawalCurve: runWithdrawalCurve
  };
});
