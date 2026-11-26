/**
 * 파이어족(FIRE) 몬테카를로 은퇴 생존확률 시뮬레이터 — 4단계 심화 경로 컨트롤러 (stress-test-app.js)
 *
 * 담당 기능:
 * 1. URL 해시(#s=...) 및 localStorage 상태 복원, 메인 시뮬레이터 복귀 해시 유지
 * 2. Web Worker(../js/montecarlo-worker.js) 기반 10,000회 정밀 시뮬레이션 비동기 실행
 * 3. 애드센스 오퍼월(보상형 광고) 잠금 해제 훅 및 광고 No-fill 5초 자동 개방 폴백 UI
 * 4. 대폭락(-30%/-40%) × 고물가(연 5%) 6종 매트릭스 및 안전 인출률(3.0%~5.0%) 생존곡선 차트
 * 5. 한글 깨짐 없는 고해상도 2페이지 A4 jsPDF 은퇴 생존 진단서 출력 (자산 금액 마스킹 지원)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var engine = require('./montecarlo-engine.js');
    var uiCore = require('./ui-core.js');
    module.exports = factory(engine, uiCore);
  } else {
    root.FireStressApp = factory(root.MonteCarloEngine, root.FireUICore);
  }
})(typeof self !== 'undefined' ? self : this, function (Engine, UICore) {
  'use strict';

  var Formatters = UICore.Formatters;
  var StateCodec = UICore.StateCodec;
  var CanvasCardBase = UICore.CanvasCardBase;
  var PdfReportBase = UICore.PdfReportBase;

  var UNLOCK_SESSION_KEY = 'kr_fire_stress_unlocked_v1';
  var CURVE_COLORS = ['#059669', '#0284c7', '#2563eb', '#d97706', '#dc2626'];

  /**
   * jsPDF 출력용 2페이지 A4 Canvas 드로잉 함수 배열 생성
   * @param {Object} suiteData Worker 결과 { base10k, shock30, stressMatrix, withdrawalCurve }
   * @param {Object} options { hideAmounts: boolean, generatedDateStr?: string }
   */
  function createPdfPageDrawers(suiteData, options) {
    var opts = options || {};
    var hideAmounts = Boolean(opts.hideAmounts);
    var base10k = suiteData.base10k;
    var shock30 = suiteData.shock30;
    var matrix = suiteData.stressMatrix;
    var wrCurve = suiteData.withdrawalCurve;
    var params = base10k.params;
    var dateStr = opts.generatedDateStr || new Date().toISOString().slice(0, 10);
    var fontStack = '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

    function maskMoney(manwon) {
      return hideAmounts ? '비공개 (마스킹)' : Formatters.formatManwon(manwon);
    }

    // 1페이지: 조건 요약 + 10,000회 생존확률 진단 + 백분위수 팬차트 + 연령별 요약표
    function drawPage1(ctx, W, H) {
      // 상단 네이비 헤더 배너
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, W, 170);
      ctx.fillStyle = base10k.grade.color;
      ctx.fillRect(0, 164, W, 8);

      ctx.fillStyle = '#93c5fd';
      ctx.font = '700 20px ' + fontStack;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('FIRE MONTE CARLO PRECISION REPORT · 10,000 SIMULATIONS', 72, 38);

      ctx.fillStyle = '#ffffff';
      ctx.font = '800 40px ' + fontStack;
      ctx.fillText('파이어족(FIRE) 은퇴 생존확률 정밀 진단서', 72, 74);

      ctx.fillStyle = '#cbd5e1';
      ctx.font = '600 20px ' + fontStack;
      ctx.textAlign = 'right';
      ctx.fillText('발행일: ' + dateStr + ' | 페이지 1 / 2', W - 72, 122);

      // 1. 시뮬레이션 입력 조건 박스
      ctx.fillStyle = '#0f172a';
      ctx.font = '800 26px ' + fontStack;
      ctx.textAlign = 'left';
      ctx.fillText('1. 분석 기준 입력 파라미터', 72, 210);

      CanvasCardBase.drawRoundRect(ctx, 72, 252, W - 144, 176, 16);
      ctx.fillStyle = '#f8fafc';
      ctx.fill();
      ctx.strokeStyle = '#cbd5e1';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      var netMonthly = Math.max(0, params.monthlyExpense - params.monthlyExtraIncome);
      var condLines = [
        ['연령 구간', params.currentAge + '세 → 목표 은퇴 ' + params.retireAge + '세 → 기대수명 ' + params.targetAge + '세'],
        ['현재 순자산 / 월 저축', maskMoney(params.currentNetWorth) + ' / ' + maskMoney(params.monthlySaving)],
        ['은퇴 후 월 순인출액', maskMoney(netMonthly) + ' (현재가치 기준)'],
        ['기대수익률 / 변동성 / 물가', '연 ' + params.expectedReturn.toFixed(1) + '% / 표준편차 ' + params.volatility.toFixed(1) + '% / 물가 ' + params.inflation.toFixed(1) + '%']
      ];

      condLines.forEach(function (pair, i) {
        var col = i % 2;
        var row = Math.floor(i / 2);
        var x = 104 + col * 530;
        var y = 278 + row * 72;
        ctx.fillStyle = '#64748b';
        ctx.font = '600 18px ' + fontStack;
        ctx.fillText(pair[0], x, y);
        ctx.fillStyle = '#0f172a';
        ctx.font = '700 22px ' + fontStack;
        ctx.fillText(pair[1], x, y + 26);
      });

      // 2. 핵심 생존확률 결과 박스
      ctx.fillStyle = '#0f172a';
      ctx.font = '800 26px ' + fontStack;
      ctx.fillText('2. 10,000회 정밀 몬테카를로 생존확률 판정', 72, 464);

      CanvasCardBase.drawRoundRect(ctx, 72, 506, W - 144, 210, 16);
      ctx.fillStyle = '#0f172a';
      ctx.fill();

      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 20px ' + fontStack;
      ctx.fillText('평시 10,000회 생존확률', 108, 536);

      ctx.fillStyle = '#ffffff';
      ctx.font = '900 74px ' + fontStack;
      ctx.fillText(base10k.survivalRate.toFixed(1) + '%', 108, 570);

      ctx.fillStyle = base10k.grade.color;
      ctx.font = '800 28px ' + fontStack;
      ctx.fillText('[' + base10k.grade.fullLabel + ']', 360, 602);

      var delta30 = (shock30.survivalRate - base10k.survivalRate).toFixed(1);
      ctx.fillStyle = '#fda4af';
      ctx.font = '700 22px ' + fontStack;
      ctx.fillText(
        '첫해 -30% 폭락 시 생존확률: ' + shock30.survivalRate.toFixed(1) + '% (' + delta30 + '%p)',
        620,
        558
      );
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '600 21px ' + fontStack;
      ctx.fillText(
        '은퇴 첫해 초기 인출률: ' + base10k.initialWithdrawalRate.toFixed(2) + '% | 은퇴자산(P50): ' + maskMoney(base10k.retireMedianReal),
        620,
        604
      );
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '500 18px ' + fontStack;
      ctx.fillText(base10k.grade.description, 108, 668);

      // 3. 미니 백분위수 팬차트 실루엣
      ctx.fillStyle = '#0f172a';
      ctx.font = '800 26px ' + fontStack;
      ctx.fillText('3. 연령별 백분위수 자산 궤적 (P10 ~ P90 팬차트)', 72, 752);

      CanvasCardBase.drawRoundRect(ctx, 72, 794, W - 144, 360, 16);
      ctx.fillStyle = '#0f172a';
      ctx.fill();

      CanvasCardBase.drawMiniFanSilhouette(
        ctx,
        { x: 116, y: 830, w: W - 232, h: 265 },
        base10k.percentilesReal,
        shock30.percentilesReal.p50
      );

      ctx.fillStyle = '#93c5fd';
      ctx.font = '600 18px ' + fontStack;
      ctx.fillText('실선: 10,000회 평시 중앙값(P50)   |   붉은 점선: 은퇴 첫해 -30% 폭락 시 중앙값(P50)', 116, 1114);

      // 4. 주요 연령 구간별 백분위수 요약 표
      ctx.fillStyle = '#0f172a';
      ctx.font = '800 26px ' + fontStack;
      ctx.fillText('4. 주요 연령대별 백분위수 자산 (현재가치 기준)', 72, 1192);

      var lastIdx = base10k.ages.length - 1;
      var rIdx = base10k.retireStep;
      var mIdx = Math.min(lastIdx, Math.round((rIdx + lastIdx) / 2));
      var steps = [0, rIdx, mIdx, lastIdx].filter(function (v, idx, arr) {
        return arr.indexOf(v) === idx;
      });

      var tableTop = 1236;
      var colX = [88, 320, 540, 760, 980];
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(72, tableTop, W - 144, 48);
      ctx.fillStyle = '#1e293b';
      ctx.font = '700 19px ' + fontStack;
      ['연령 구간', '하위 10%(P10)', '하위 25%(P25)', '중앙값(P50)', '상위 10%(P90)'].forEach(function (h, ci) {
        ctx.fillText(h, colX[ci], tableTop + 14);
      });

      steps.forEach(function (stIdx, ri) {
        var ry = tableTop + 48 + ri * 54;
        ctx.fillStyle = ri % 2 === 0 ? '#ffffff' : '#f8fafc';
        ctx.fillRect(72, ry, W - 144, 54);
        ctx.strokeStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.moveTo(72, ry + 54);
        ctx.lineTo(W - 72, ry + 54);
        ctx.stroke();

        var pReal = base10k.percentilesReal;
        var label = base10k.ages[stIdx] + '세' + (stIdx === rIdx ? ' (은퇴)' : stIdx === lastIdx ? ' (기대수명)' : '');
        var vals = [
          label,
          maskMoney(pReal.p10[stIdx]),
          maskMoney(pReal.p25[stIdx]),
          maskMoney(pReal.p50[stIdx]),
          maskMoney(pReal.p90[stIdx])
        ];
        ctx.fillStyle = '#0f172a';
        ctx.font = '600 19px ' + fontStack;
        vals.forEach(function (v, ci) {
          ctx.fillText(v, colX[ci], ry + 16);
        });
      });

      ctx.fillStyle = '#64748b';
      ctx.font = '500 17px ' + fontStack;
      ctx.textAlign = 'center';
      ctx.fillText('fire-montecarlo.enjoy-onepage.com/stress-test/ · 브라우저 로컬 연산 정밀 리포트', W / 2, H - 56);
    }

    // 2페이지: 복합 스트레스 매트릭스 + 안전 인출률 비교표 + 핵심 실행 권고 및 면책공고
    function drawPage2(ctx, W, H) {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, W, 130);
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 32px ' + fontStack;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('복합 위기 스트레스 매트릭스 & 안전 인출률 분석', 72, 46);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '600 20px ' + fontStack;
      ctx.textAlign = 'right';
      ctx.fillText('발행일: ' + dateStr + ' | 페이지 2 / 2', W - 72, 54);

      // 5. 복합 스트레스 매트릭스 테이블
      ctx.fillStyle = '#0f172a';
      ctx.font = '800 26px ' + fontStack;
      ctx.textAlign = 'left';
      ctx.fillText('5. 대폭락(-30% / -40%) × 고물가(연 5%) 6종 시나리오 매트릭스', 72, 174);

      var mTop = 220;
      var mCols = [86, 535, 685, 815, 985];
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(72, mTop, W - 144, 50);
      ctx.fillStyle = '#1e293b';
      ctx.font = '700 18px ' + fontStack;
      ['시나리오 조건', '생존확률', '등급', 'P10 소진', '잔여자산(P50)'].forEach(function (h, i) {
        ctx.fillText(h, mCols[i], mTop + 15);
      });

      matrix.forEach(function (row, ri) {
        var ry = mTop + 50 + ri * 58;
        ctx.fillStyle = ri % 2 === 0 ? '#ffffff' : '#f8fafc';
        ctx.fillRect(72, ry, W - 144, 58);
        ctx.strokeStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.moveTo(72, ry + 58);
        ctx.lineTo(W - 72, ry + 58);
        ctx.stroke();

        ctx.fillStyle = '#0f172a';
        ctx.font = '600 18px ' + fontStack;
        ctx.fillText(row.label, mCols[0], ry + 18);

        ctx.fillStyle = row.grade.color;
        ctx.font = '800 20px ' + fontStack;
        ctx.fillText(row.survivalRate.toFixed(1) + '%', mCols[1], ry + 17);
        ctx.fillText(row.grade.label, mCols[2], ry + 17);

        ctx.fillStyle = '#334155';
        ctx.font = '600 18px ' + fontStack;
        ctx.fillText(row.p10DepletionAge ? row.p10DepletionAge + '세' : '생존 유지', mCols[3], ry + 18);
        ctx.fillText(maskMoney(row.finalMedianReal), mCols[4], ry + 18);
      });

      // 6. 안전 인출률(3.0% ~ 5.0%) 구간별 비교표
      ctx.fillStyle = '#0f172a';
      ctx.font = '800 26px ' + fontStack;
      ctx.fillText('6. 안전 인출률(3.0% ~ 5.0%) 구간별 생존확률 비교', 72, 624);

      var wTop = 670;
      var wCols = [92, 290, 560, 830, 1020];
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(72, wTop, W - 144, 50);
      ctx.fillStyle = '#1e293b';
      ctx.font = '700 18px ' + fontStack;
      ['초기 인출률', '월 순인출 가능액', '고정수입 합산 생활비', '최종 생존확률', '판정'].forEach(function (h, i) {
        ctx.fillText(h, wCols[i], wTop + 15);
      });

      wrCurve.curves.forEach(function (c, ri) {
        var ry = wTop + 50 + ri * 58;
        ctx.fillStyle = ri % 2 === 0 ? '#ffffff' : '#f8fafc';
        ctx.fillRect(72, ry, W - 144, 58);
        ctx.strokeStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.moveTo(72, ry + 58);
        ctx.lineTo(W - 72, ry + 58);
        ctx.stroke();

        ctx.fillStyle = '#0f172a';
        ctx.font = '700 19px ' + fontStack;
        ctx.fillText('연 ' + c.ratePct.toFixed(1) + '%', wCols[0], ry + 18);
        ctx.font = '600 18px ' + fontStack;
        ctx.fillText(maskMoney(c.impliedNetMonthlyReal), wCols[1], ry + 18);
        ctx.fillText(maskMoney(c.impliedTotalMonthlyReal), wCols[2], ry + 18);

        ctx.fillStyle = c.grade.color;
        ctx.font = '800 20px ' + fontStack;
        ctx.fillText(c.finalSurvivalRate.toFixed(1) + '%', wCols[3], ry + 17);
        ctx.fillText(c.grade.fullLabel, wCols[4], ry + 17);
      });

      // 7. 진단 요약 코멘트 및 면책 안내 상자
      CanvasCardBase.drawRoundRect(ctx, 72, 1060, W - 144, 290, 18);
      ctx.fillStyle = '#eff6ff';
      ctx.fill();
      ctx.strokeStyle = '#bfdbfe';
      ctx.stroke();

      ctx.fillStyle = '#1e3a8a';
      ctx.font = '800 24px ' + fontStack;
      ctx.fillText('7. 수익률 순서 위험(Sequence of Returns Risk) 관리 포인트', 104, 1094);

      var wrNow = base10k.initialWithdrawalRate;
      var tip1 = wrNow <= 3.8
        ? '• 현재 초기 인출률(' + wrNow.toFixed(2) + '%)은 보수적 안전 구간(3.5~3.8%) 이내로 설계되어 있습니다.'
        : '• 현재 초기 인출률(' + wrNow.toFixed(2) + '%)이 다소 높으므로 은퇴 시점 1~2년 연장 또는 지출 유연화를 검토하세요.';
      var tip2 = '• 은퇴 첫해 -30% 하락 시 생존확률이 ' + base10k.survivalRate.toFixed(1) + '%에서 ' +
        shock30.survivalRate.toFixed(1) + '%로 변동합니다.';
      var tip3 = '• 은퇴 직후 2~3년치 생활비를 별도 현금성 버퍼로 분리하면 하락장 저가 매도 위험을 크게 낮출 수 있습니다.';

      ctx.fillStyle = '#1e293b';
      ctx.font = '600 20px ' + fontStack;
      ctx.fillText(tip1, 104, 1148);
      ctx.fillText(tip2, 104, 1194);
      ctx.fillText(tip3, 104, 1240);

      // 하단 면책 공고
      ctx.fillStyle = '#64748b';
      ctx.font = '500 17px ' + fontStack;
      ctx.fillText(
        '※ 면책 공고: 본 문서는 사용자가 직접 입력한 수익률·변동성·물가 가정에 기반한 박스-뮬러 몬테카를로 통계 추정치입니다.',
        72,
        1420
      );
      ctx.fillText(
        '   세법·공적연금·건강보험료 등 개별 법령 기준은 포함되지 않으며, 특정 금융상품 투자 권유나 미래 수익을 보장하지 않습니다.',
        72,
        1450
      );

      ctx.textAlign = 'center';
      ctx.fillText('fire-montecarlo.enjoy-onepage.com/stress-test/ · 서버 전송 없는 100% 로컬 생성 문서', W / 2, H - 56);
    }

    return [drawPage1, drawPage2];
  }

  /**
   * 안전 인출률(3.0% ~ 5.0%) 다중 라인 차트 자체 Canvas 2D 폴백 렌더러
   */
  function drawFallbackWithdrawalChart(canvasEl, wrCurveData) {
    if (!canvasEl || !canvasEl.getContext) return;
    var rect = canvasEl.parentElement
      ? canvasEl.parentElement.getBoundingClientRect()
      : { width: 640, height: 340 };
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    var cssW = Math.max(300, Math.floor(rect.width || 640));
    var cssH = Math.max(240, Math.floor(rect.height || 340));

    canvasEl.width = Math.floor(cssW * dpr);
    canvasEl.height = Math.floor(cssH * dpr);
    var ctx = canvasEl.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var pad = { top: 20, right: 24, bottom: 36, left: 50 };
    var plotW = cssW - pad.left - pad.right;
    var plotH = cssH - pad.top - pad.bottom;
    var ages = wrCurveData.retireAges;
    var n = ages.length;
    if (n < 2) return;

    function xAt(i) { return pad.left + (i / (n - 1)) * plotW; }
    function yAt(pct) { return pad.top + plotH - (Math.max(0, Math.min(100, pct)) / 100) * plotH; }

    ctx.strokeStyle = '#e2e8f0';
    ctx.fillStyle = '#64748b';
    ctx.font = '11px Pretendard, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [0, 25, 50, 75, 100].forEach(function (pct) {
      var gy = yAt(pct);
      ctx.beginPath();
      ctx.moveTo(pad.left, gy);
      ctx.lineTo(pad.left + plotW, gy);
      ctx.stroke();
      ctx.fillText(pct + '%', pad.left - 8, gy);
    });

    wrCurveData.curves.forEach(function (curve, cIdx) {
      ctx.beginPath();
      for (var i = 0; i < n; i++) {
        if (i === 0) ctx.moveTo(xAt(i), yAt(curve.survivalByAge[i]));
        else ctx.lineTo(xAt(i), yAt(curve.survivalByAge[i]));
      }
      ctx.strokeStyle = CURVE_COLORS[cIdx % CURVE_COLORS.length];
      ctx.lineWidth = curve.ratePct === 4.0 ? 3 : 2;
      ctx.stroke();
    });
  }

  /**
   * 브라우저 심화 페이지 초기화
   */
  function initStressTestPage() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    var gateCard = document.getElementById('offerwallGateCard');
    var reportWrap = document.getElementById('deepReportContent');
    if (!gateCard || !reportWrap) return;

    function byId(id) { return document.getElementById(id); }

    // 1. 상태 복원 (URL 해시 -> localStorage -> 기본값)
    var currentParams = Object.assign({}, Engine.DEFAULT_PARAMS);
    var shockEnabled = false;
    var hideAmounts = false;

    var fromHash = StateCodec.decodeHash(window.location.hash);
    var fromLocal = StateCodec.loadLocal();
    if (fromHash) {
      currentParams = fromHash.params;
      shockEnabled = fromHash.shockEnabled;
      hideAmounts = fromHash.hideAmounts;
    } else if (fromLocal) {
      currentParams = fromLocal.params;
      shockEnabled = fromLocal.shockEnabled;
      hideAmounts = fromLocal.hideAmounts;
    }

    var pdfHideCheck = byId('togglePdfHideAmounts');
    if (pdfHideCheck) {
      pdfHideCheck.checked = hideAmounts;
    }

    // 메인 복귀 링크에 해시 유지
    var backLink = byId('linkBackToMain');
    if (backLink) {
      var backHash = StateCodec.encodeHash(currentParams, {
        shockEnabled: shockEnabled,
        hideAmounts: hideAmounts
      });
      backLink.setAttribute('href', '../' + backHash);
    }

    // 조건 요약 칩 렌더링
    var chipsBox = byId('condChipsContainer');
    if (chipsBox) {
      var netM = Math.max(0, currentParams.monthlyExpense - currentParams.monthlyExtraIncome);
      var chipItems = [
        '연령 <strong>' + currentParams.currentAge + '세 → 은퇴 ' + currentParams.retireAge + '세 → ' + currentParams.targetAge + '세</strong>',
        '현재 순자산 <strong>' + (hideAmounts ? '비공개(정규화)' : Formatters.formatManwon(currentParams.currentNetWorth)) + '</strong>',
        '월 저축 <strong>' + (hideAmounts ? '비공개' : Formatters.formatManwon(currentParams.monthlySaving)) + '</strong>',
        '은퇴 월 순인출 <strong>' + (hideAmounts ? '비율 기준' : Formatters.formatManwon(netM)) + '</strong>',
        '기대수익률 <strong>' + currentParams.expectedReturn.toFixed(1) + '%</strong> · 변동성 <strong>' + currentParams.volatility.toFixed(1) + '%</strong> · 물가 <strong>' + currentParams.inflation.toFixed(1) + '%</strong>'
      ];
      chipsBox.innerHTML = chipItems.map(function (html) {
        return '<span class="cond-chip">' + html + '</span>';
      }).join('');
    }

    var workerClient = UICore.createWorkerClient('../js/montecarlo-worker.js');
    var fanChartCtrl = byId('stressFanChartCanvas')
      ? UICore.createFanChartController(byId('stressFanChartCanvas'))
      : null;
    var wrChartInstance = null;

    var isUnlocked = false;
    var latestSuiteData = null;
    var currentSeed = 20261126;
    var fallbackInterval = null;

    try {
      if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(UNLOCK_SESSION_KEY) === '1') {
        isUnlocked = true;
      }
    } catch (_e) {
      // sessionStorage 비활성 환경 무시
    }

    /**
     * 인출률(3.0% ~ 5.0%) 다중 생존곡선 차트 업데이트
     */
    function renderWithdrawalCurveChart(wrCurveData) {
      var canvasEl = byId('withdrawalCurveCanvas');
      if (!canvasEl) return;

      UICore.loadScriptOnce(UICore.CDN_URLS.chartJs, function () {
        return typeof window.Chart !== 'undefined';
      }).then(function () {
        var Chart = window.Chart;
        var labels = wrCurveData.retireAges.map(function (a) { return a + '세'; });
        var datasets = wrCurveData.curves.map(function (c, idx) {
          var color = CURVE_COLORS[idx % CURVE_COLORS.length];
          return {
            label: '인출률 ' + c.ratePct.toFixed(1) + '% (최종 ' + c.finalSurvivalRate.toFixed(1) + '%)',
            data: c.survivalByAge,
            borderColor: color,
            backgroundColor: 'transparent',
            borderWidth: c.ratePct === 4.0 ? 3.2 : 2.0,
            borderDash: c.ratePct === 4.0 ? [] : (c.ratePct > 4.0 ? [5, 4] : []),
            pointRadius: 0,
            tension: 0.2
          };
        });

        if (wrChartInstance) {
          wrChartInstance.data.labels = labels;
          wrChartInstance.data.datasets = datasets;
          wrChartInstance.update('none');
          return;
        }

        wrChartInstance = new Chart(canvasEl.getContext('2d'), {
          type: 'line',
          data: { labels: labels, datasets: datasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { position: 'bottom', labels: { boxWidth: 14, font: { size: 11 } } },
              tooltip: {
                callbacks: {
                  label: function (ctx) { return ctx.dataset.label.split(' (')[0] + ': 생존율 ' + ctx.parsed.y.toFixed(1) + '%'; }
                }
              }
            },
            scales: {
              x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
              y: {
                min: 0,
                max: 100,
                ticks: { callback: function (v) { return v + '%'; } }
              }
            }
          }
        });
      }).catch(function () {
        drawFallbackWithdrawalChart(canvasEl, wrCurveData);
      });
    }

    /**
     * Worker 연산 결과를 심화 리포트 DOM에 바인딩
     */
    function renderDeepReportDom(suite) {
      if (!suite) return;
      var base10k = suite.base10k;
      var shock30 = suite.shock30;
      var matrix = suite.stressMatrix;
      var wrCurve = suite.withdrawalCurve;

      var mainBadge = byId('stressMainGradeBadge');
      if (mainBadge) {
        mainBadge.className = 'grade-badge ' + base10k.grade.badgeClass;
        mainBadge.textContent = '10,000회 ' + base10k.grade.fullLabel;
      }

      var elBaseRate = byId('stressKpiBaseRate');
      if (elBaseRate) {
        elBaseRate.textContent = base10k.survivalRate.toFixed(1) + '%';
        elBaseRate.style.color = base10k.grade.color;
      }
      var elBaseSub = byId('stressKpiBaseSub');
      if (elBaseSub) {
        elBaseSub.textContent = '10,000회 중 ' + base10k.survivedCount.toLocaleString('ko-KR') + '회 생존';
      }

      var elShockRate = byId('stressKpiShock30Rate');
      if (elShockRate) elShockRate.textContent = shock30.survivalRate.toFixed(1) + '%';
      var elShockDelta = byId('stressKpiShock30Delta');
      if (elShockDelta) {
        var diff = (shock30.survivalRate - base10k.survivalRate).toFixed(1);
        elShockDelta.textContent = '평시 대비 ' + diff + '%p 하락 (' + shock30.grade.fullLabel + ')';
      }

      var elRetAsset = byId('stressKpiRetireAsset');
      if (elRetAsset) {
        elRetAsset.textContent = hideAmounts ? '비공개(비율 기준)' : Formatters.formatManwon(base10k.retireMedianReal);
      }
      var elInitWr = byId('stressKpiInitWr');
      if (elInitWr) {
        elInitWr.textContent = '은퇴 첫해 초기 인출률 ' + base10k.initialWithdrawalRate.toFixed(2) + '%';
      }

      var elP10 = byId('stressKpiP10Status');
      var elP10Sub = byId('stressKpiP10Sub');
      if (elP10 && elP10Sub) {
        if (base10k.p10DepletionAge !== null) {
          elP10.textContent = base10k.p10DepletionAge + '세 소진';
          elP10Sub.textContent = '하위 10% 불황 경로 고갈 시점';
        } else {
          elP10.textContent = base10k.params.targetAge + '세 생존';
          elP10Sub.textContent = '하위 10% 경로도 고갈 없음';
        }
      }

      // 6종 스트레스 매트릭스 테이블
      var matrixTbody = byId('stressMatrixTableBody');
      if (matrixTbody) {
        matrixTbody.innerHTML = matrix.map(function (row) {
          var p10Txt = row.p10DepletionAge ? row.p10DepletionAge + '세 소진' : '고갈 없음';
          var p50Txt = row.medianDepletionAge ? row.medianDepletionAge + '세 소진' : '고갈 없음';
          var remTxt = hideAmounts ? '비공개' : Formatters.formatManwon(row.finalMedianReal);
          return (
            '<tr>' +
              '<td><strong>' + row.label + '</strong></td>' +
              '<td style="font-weight:800;color:' + row.grade.color + ';">' + row.survivalRate.toFixed(1) + '%</td>' +
              '<td><span class="grade-badge ' + row.grade.badgeClass + '">' + row.grade.label + '</span></td>' +
              '<td>' + p10Txt + '</td>' +
              '<td>' + p50Txt + '</td>' +
              '<td>' + remTxt + '</td>' +
            '</tr>'
          );
        }).join('');
      }

      // 안전 인출률(3.0% ~ 5.0%) 테이블
      var wrTbody = byId('withdrawalCurveTableBody');
      if (wrTbody) {
        wrTbody.innerHTML = wrCurve.curves.map(function (c) {
          var netTxt = hideAmounts ? '비공개' : Formatters.formatManwon(c.impliedNetMonthlyReal);
          var totTxt = hideAmounts ? '비공개' : Formatters.formatManwon(c.impliedTotalMonthlyReal);
          var highlight = c.ratePct === 4.0 ? ' style="background:var(--bg-accent-soft);"' : '';
          return (
            '<tr' + highlight + '>' +
              '<td><strong>연 ' + c.ratePct.toFixed(1) + '%</strong>' + (c.ratePct === 4.0 ? ' <small>(4% 룰)</small>' : '') + '</td>' +
              '<td>' + netTxt + '</td>' +
              '<td>' + totTxt + '</td>' +
              '<td style="font-weight:800;color:' + c.grade.color + ';">' + c.finalSurvivalRate.toFixed(1) + '%</td>' +
              '<td><span class="grade-badge ' + c.grade.badgeClass + '">' + c.grade.fullLabel + '</span></td>' +
            '</tr>'
          );
        }).join('');
      }

      // 차트 업데이트 (리포트가 열려 있을 때 레이아웃 폭 기준 렌더링)
      if (isUnlocked) {
        if (fanChartCtrl) {
          fanChartCtrl.update(base10k, shock30, true).catch(function () {});
        }
        renderWithdrawalCurveChart(wrCurve);
      }
    }

    /**
     * 심화 리포트 잠금 해제 처리
     */
    function unlockReport(reason) {
      if (fallbackInterval) {
        clearInterval(fallbackInterval);
        fallbackInterval = null;
      }
      isUnlocked = true;
      gateCard.classList.add('is-hidden');
      reportWrap.classList.remove('is-locked');
      reportWrap.setAttribute('data-unlock-reason', reason || 'unlocked');

      try {
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(UNLOCK_SESSION_KEY, '1');
        }
      } catch (_e) {}

      if (latestSuiteData) {
        renderDeepReportDom(latestSuiteData);
      }
    }

    /**
     * 보상형 광고 No-fill / 타임아웃 시 동작하는 5초 대기 폴백 UI
     */
    function startNoFillFallback() {
      var unlockBtn = byId('btnUnlockRewardAd');
      var fbBox = byId('offerwallFallbackBox');
      var fbBar = byId('offerwallFallbackBar');
      var fbLabel = byId('offerwallCountdownLabel');
      var fbOpenBtn = byId('btnFallbackImmediateOpen');

      if (unlockBtn) {
        unlockBtn.disabled = true;
        unlockBtn.textContent = '무료 폴백 열람 준비 중...';
      }
      if (fbBox) fbBox.classList.add('is-visible');

      var totalMs = typeof window.FIRE_FALLBACK_DURATION_MS === 'number'
        ? Math.max(20, window.FIRE_FALLBACK_DURATION_MS)
        : 5000;
      var stepMs = Math.min(100, Math.max(10, Math.floor(totalMs / 20)));
      var startedAt = Date.now();

      if (fallbackInterval) clearInterval(fallbackInterval);
      fallbackInterval = setInterval(function () {
        var elapsed = Date.now() - startedAt;
        var pct = Math.min(100, Math.round((elapsed / totalMs) * 100));
        if (fbBar) fbBar.style.width = pct + '%';
        var remainSec = Math.max(0, Math.ceil((totalMs - elapsed) / 1000));
        if (fbLabel) fbLabel.textContent = '남은 시간: ' + remainSec + '초';

        if (elapsed >= totalMs) {
          clearInterval(fallbackInterval);
          fallbackInterval = null;
          if (fbOpenBtn) fbOpenBtn.style.display = 'inline-flex';
          unlockReport('nofill_fallback');
        }
      }, stepMs);
    }

    /**
     * 백그라운드 Web Worker 10,000회 실행 트리거
     */
    function executeWorker10k() {
      var badge = byId('workerStatusBadge');
      var elapsedEl = byId('condWorkerElapsed');
      if (badge) badge.textContent = 'Web Worker 10,000회 연산 중...';

      workerClient.runStressSuite(currentParams, {
        iterations: 10000,
        seed: currentSeed
      }).then(function (res) {
        latestSuiteData = res.result;
        var modeTxt = res.fallback ? '비동기 로컬 연산' : 'Web Worker 병렬 연산';
        if (badge) badge.textContent = '10,000회 완료 · ' + res.totalElapsedMs + 'ms';
        if (elapsedEl) elapsedEl.textContent = modeTxt + ' 완료 (' + res.totalElapsedMs + 'ms)';
        renderDeepReportDom(latestSuiteData);
      }).catch(function () {
        if (badge) badge.textContent = '연산 오류 발생';
      });
    }

    // 오퍼월 잠금 해제 버튼 클릭
    var btnUnlock = byId('btnUnlockRewardAd');
    if (btnUnlock) {
      btnUnlock.addEventListener('click', function () {
        // 1. 커스텀 보상형 광고 공급자 훅이 설정된 경우
        if (window.FireRewardAdProvider && typeof window.FireRewardAdProvider.showRewardedAd === 'function') {
          window.FireRewardAdProvider.showRewardedAd({
            onRewarded: function () { unlockReport('custom_reward_ad'); },
            onNoFill: function () { startNoFillFallback(); }
          });
          return;
        }

        // 2. Google AdSense H5 / Offerwall Placement API (window.adBreak) 연동
        if (typeof window.adBreak === 'function') {
          var handled = false;
          var guardTimer = setTimeout(function () {
            if (!handled) {
              handled = true;
              startNoFillFallback();
            }
          }, 1500);

          try {
            window.adBreak({
              type: 'reward',
              name: 'unlock_fire_stress_10k',
              beforeReward: function (showAdFn) {
                clearTimeout(guardTimer);
                showAdFn();
              },
              adViewed: function () {
                handled = true;
                clearTimeout(guardTimer);
                unlockReport('adsense_reward_viewed');
              },
              adDismissed: function () {
                handled = true;
                clearTimeout(guardTimer);
                btnUnlock.disabled = false;
                btnUnlock.textContent = '보상형 광고 보고 정밀 리포트 열기';
              },
              adBreakDone: function (placementInfo) {
                if (handled) return;
                handled = true;
                clearTimeout(guardTimer);
                if (placementInfo && placementInfo.breakStatus === 'viewed') {
                  unlockReport('adsense_reward_done');
                } else {
                  startNoFillFallback();
                }
              }
            });
          } catch (_e) {
            clearTimeout(guardTimer);
            startNoFillFallback();
          }
          return;
        }

        // 3. 광고 스크립트 미로드 / AdBlock / No-fill 환경 -> 즉시 5초 폴백 타이머 가동
        startNoFillFallback();
      });
    }

    var btnFallbackOpen = byId('btnFallbackImmediateOpen');
    if (btnFallbackOpen) {
      btnFallbackOpen.addEventListener('click', function () {
        unlockReport('manual_fallback_button');
      });
    }

    // 10,000회 난수 재검증 버튼
    var btnRerun = byId('btnRerun10k');
    if (btnRerun) {
      btnRerun.addEventListener('click', function () {
        currentSeed = Math.floor(Math.random() * 2000000000) + 1;
        executeWorker10k();
      });
    }

    // jsPDF 은퇴 진단서 다운로드 버튼
    var btnPdf = byId('btnExportPdfReport');
    var pdfStatusEl = byId('pdfExportStatus');
    if (btnPdf) {
      btnPdf.addEventListener('click', function () {
        if (!latestSuiteData) return;
        var maskChecked = pdfHideCheck ? Boolean(pdfHideCheck.checked) : false;
        if (pdfStatusEl) pdfStatusEl.textContent = 'PDF 진단서 생성 중...';

        var drawers = createPdfPageDrawers(latestSuiteData, {
          hideAmounts: maskChecked
        });
        var fname = 'fire-stress-report-' + currentParams.retireAge + 'y.pdf';

        PdfReportBase.exportCanvasPagesToPdf(drawers, fname).then(function () {
          if (pdfStatusEl) pdfStatusEl.textContent = '2페이지 A4 진단서 PDF 저장 완료!';
        }).catch(function () {
          if (pdfStatusEl) pdfStatusEl.textContent = '인쇄 대화상자로 전환합니다...';
          if (typeof window.print === 'function') window.print();
        });
      });
    }

    // 세션 내 기해제 상태면 즉시 개방
    if (isUnlocked) {
      unlockReport('session_restored');
    }

    // 진입 즉시 백그라운드 10,000회 연산 시작
    executeWorker10k();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initStressTestPage);
    } else {
      initStressTestPage();
    }
  }

  return {
    createPdfPageDrawers: createPdfPageDrawers
  };
});
