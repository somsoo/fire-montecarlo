/**
 * 파이어족(FIRE) 몬테카를로 은퇴 생존확률 시뮬레이터 — 메인 페이지 컨트롤러 (main-app.js)
 *
 * 담당 기능 (2단계):
 * - 초기 상태 복원 (URL 해시 #s=... -> localStorage -> DEFAULT_PARAMS)
 * - 10개 입력 슬라이더·숫자 필드 실시간 바인딩 및 포트폴리오 성향 프리셋 3종 연동
 * - 박스-뮬러 2,000회 시뮬레이션 즉시 연산 및 KPI·등급 배지·백분위수 요약표 렌더링
 * - '은퇴 첫해 -30% 폭락장 스트레스 테스트' 즉시 비교 토글 연동
 * - Chart.js 팬차트(P10~P90) 렌더링 + CDN 차단/오프라인 환경용 네이티브 Canvas 팬차트 폴백
 * - URL 해시 상태 압축 복사(자산 총액 숨김 공유 옵션 지원) 및 심화 경로(./stress-test/) 상태 전달
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  var Engine = window.MonteCarloEngine;
  var UICore = window.FireUICore;
  if (!Engine || !UICore) {
    return;
  }

  var Formatters = UICore.Formatters;
  var StateCodec = UICore.StateCodec;

  var currentSeed = 20261125;
  var useRealValuation = true;
  var shockEnabled = false;
  var hideAmountsShare = false;

  var latestBaseSim = null;
  var latestShockSim = null;
  var sliderController = null;
  var fanChartController = null;
  var copyToastTimer = null;

  function byId(id) {
    return document.getElementById(id);
  }

  /**
   * Chart.js CDN 로드 실패(오프라인·차단기 등) 시 동작하는 자체 Canvas 2D 팬차트 폴백 렌더러
   */
  function drawNativeFallbackFanChart(canvasEl, baseSim, shockSim, isReal) {
    if (!canvasEl || !canvasEl.getContext) return;
    var rect = canvasEl.parentElement
      ? canvasEl.parentElement.getBoundingClientRect()
      : { width: 640, height: 340 };
    var dpr = window.devicePixelRatio || 1;
    var cssW = Math.max(300, Math.floor(rect.width || 640));
    var cssH = Math.max(240, Math.floor(rect.height || 340));

    canvasEl.width = Math.floor(cssW * dpr);
    canvasEl.height = Math.floor(cssH * dpr);
    var ctx = canvasEl.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var pad = { top: 22, right: 20, bottom: 34, left: 58 };
    var plotW = cssW - pad.left - pad.right;
    var plotH = cssH - pad.top - pad.bottom;

    var pSet = isReal ? baseSim.percentilesReal : baseSim.percentilesNominal;
    var ages = baseSim.ages;
    var n = ages.length;
    if (n < 2) return;

    var maxY = 1000;
    for (var i = 0; i < n; i++) {
      if (pSet.p90[i] > maxY) maxY = pSet.p90[i];
    }
    maxY = maxY * 1.06;

    function xAt(idx) {
      return pad.left + (idx / (n - 1)) * plotW;
    }
    function yAt(val) {
      var clamped = Math.max(0, Math.min(maxY, val));
      return pad.top + plotH - (clamped / maxY) * plotH;
    }

    // 가로 눈금선 및 Y축 라벨
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '11px Pretendard, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var g = 0; g <= 4; g++) {
      var ratio = g / 4;
      var gy = pad.top + plotH - ratio * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, gy);
      ctx.lineTo(pad.left + plotW, gy);
      ctx.stroke();
      ctx.fillText(Formatters.formatAxisManwon(maxY * ratio), pad.left - 8, gy);
    }

    // 백분위수 밴드 채움
    function fillBand(upper, lower, color) {
      ctx.beginPath();
      for (var a = 0; a < n; a++) {
        if (a === 0) ctx.moveTo(xAt(a), yAt(upper[a]));
        else ctx.lineTo(xAt(a), yAt(upper[a]));
      }
      for (var b = n - 1; b >= 0; b--) {
        ctx.lineTo(xAt(b), yAt(lower[b]));
      }
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    fillBand(pSet.p90, pSet.p10, 'rgba(37, 99, 235, 0.10)');
    fillBand(pSet.p75, pSet.p25, 'rgba(37, 99, 235, 0.20)');

    // 은퇴 기준선
    var rx = xAt(baseSim.retireStep);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#475569';
    ctx.beginPath();
    ctx.moveTo(rx, pad.top);
    ctx.lineTo(rx, pad.top + plotH);
    ctx.stroke();
    ctx.restore();

    // P50 중앙값 실선
    ctx.beginPath();
    for (var k = 0; k < n; k++) {
      if (k === 0) ctx.moveTo(xAt(k), yAt(pSet.p50[k]));
      else ctx.lineTo(xAt(k), yAt(pSet.p50[k]));
    }
    ctx.strokeStyle = '#1d4ed8';
    ctx.lineWidth = 2.6;
    ctx.stroke();

    // 첫해 폭락 P50 점선
    if (shockSim) {
      var sSet = isReal ? shockSim.percentilesReal : shockSim.percentilesNominal;
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      for (var s = 0; s < n; s++) {
        if (s === 0) ctx.moveTo(xAt(s), yAt(sSet.p50[s]));
        else ctx.lineTo(xAt(s), yAt(sSet.p50[s]));
      }
      ctx.strokeStyle = '#e11d48';
      ctx.lineWidth = 2.4;
      ctx.stroke();
      ctx.restore();
    }

    // X축 연령 라벨
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var tickStep = Math.max(1, Math.round(n / 7));
    for (var xIdx = 0; xIdx < n; xIdx += tickStep) {
      ctx.fillText(ages[xIdx] + '세', xAt(xIdx), pad.top + plotH + 8);
    }
    if ((n - 1) % tickStep !== 0) {
      ctx.fillText(ages[n - 1] + '세', xAt(n - 1), pad.top + plotH + 8);
    }
  }

  /**
   * 포트폴리오 프리셋 버튼 활성 상태 동기화
   */
  function syncPresetHighlight(params) {
    var buttons = document.querySelectorAll('.preset-btn[data-preset]');
    buttons.forEach(function (btn) {
      var key = btn.getAttribute('data-preset');
      var preset = Engine.PORTFOLIO_PRESETS[key];
      var isMatch = preset &&
        Math.abs(params.expectedReturn - preset.expectedReturn) < 0.05 &&
        Math.abs(params.volatility - preset.volatility) < 0.05;
      btn.classList.toggle('is-active', Boolean(isMatch));
    });
  }

  /**
   * 연령대별 백분위수 요약 테이블 업데이트
   */
  function renderMilestoneTable(simToDisplay, isReal) {
    var tbody = byId('milestoneTableBody');
    if (!tbody) return;

    var pSet = isReal ? simToDisplay.percentilesReal : simToDisplay.percentilesNominal;
    var ages = simToDisplay.ages;
    var lastIdx = ages.length - 1;
    var retireIdx = simToDisplay.retireStep;
    var midRetireIdx = Math.min(lastIdx, Math.round((retireIdx + lastIdx) / 2));

    var indices = [0];
    if (retireIdx > 0 && indices.indexOf(retireIdx) === -1) {
      indices.push(retireIdx);
    }
    if (midRetireIdx > retireIdx && midRetireIdx < lastIdx) {
      indices.push(midRetireIdx);
    }
    if (lastIdx > 0 && indices.indexOf(lastIdx) === -1) {
      indices.push(lastIdx);
    }

    var rowsHtml = indices.map(function (idx) {
      var tag = '';
      if (idx === 0) tag = ' (현재)';
      else if (idx === retireIdx) tag = ' (은퇴 시점)';
      else if (idx === lastIdx) tag = ' (기대수명)';

      return (
        '<tr>' +
          '<td><strong>' + ages[idx] + '세</strong>' + tag + '</td>' +
          '<td>' + Formatters.formatManwon(pSet.p10[idx]) + '</td>' +
          '<td>' + Formatters.formatManwon(pSet.p25[idx]) + '</td>' +
          '<td><strong>' + Formatters.formatManwon(pSet.p50[idx]) + '</strong></td>' +
          '<td>' + Formatters.formatManwon(pSet.p75[idx]) + '</td>' +
          '<td>' + Formatters.formatManwon(pSet.p90[idx]) + '</td>' +
        '</tr>'
      );
    }).join('');

    tbody.innerHTML = rowsHtml;
  }

  /**
   * 심화 스트레스 테스트 링크에 현재 상태 해시 연결
   */
  function syncStressTestLink(params) {
    var linkEl = byId('linkStressTestPage');
    if (!linkEl) return;
    var hash = StateCodec.encodeHash(params, {
      shockEnabled: shockEnabled,
      hideAmounts: false,
      initialWithdrawalRate: latestBaseSim ? latestBaseSim.initialWithdrawalRate : 4.0
    });
    linkEl.setAttribute('href', './stress-test/' + hash);
  }

  /**
   * 시뮬레이션 실행 및 전체 결과 UI 반영
   */
  function recalculateAndRender(params) {
    var cleanParams = Engine.sanitizeParams(params);
    syncPresetHighlight(cleanParams);

    latestBaseSim = Engine.runSimulation(cleanParams, {
      iterations: 2000,
      firstYearShock: null,
      seed: currentSeed
    });

    latestShockSim = shockEnabled
      ? Engine.runSimulation(cleanParams, {
          iterations: 2000,
          firstYearShock: -0.30,
          seed: currentSeed
        })
      : null;

    var activeSim = shockEnabled && latestShockSim ? latestShockSim : latestBaseSim;
    var grade = activeSim.grade;

    // 헤더 및 메타 소요시간 배지 업데이트
    var totalElapsed = latestBaseSim.elapsedMs + (latestShockSim ? latestShockSim.elapsedMs : 0);
    var headerPerf = byId('headerPerfBadge');
    if (headerPerf) {
      headerPerf.textContent = '2,000회 · ' + totalElapsed.toFixed(1) + 'ms';
    }
    var metaPerf = byId('kpiSimCountMeta');
    if (metaPerf) {
      metaPerf.textContent = shockEnabled
        ? '2,000회 (은퇴 첫해 -30% 폭락 적용 · ' + totalElapsed.toFixed(1) + 'ms)'
        : '2,000회 시뮬레이션 기준 (' + latestBaseSim.elapsedMs.toFixed(1) + 'ms)';
    }

    // 히어로 생존확률 & 등급 배지
    var rateEl = byId('kpiSurvivalRate');
    if (rateEl) {
      rateEl.textContent = Formatters.formatPercent(activeSim.survivalRate, 1);
      rateEl.style.color = grade.color;
    }

    var badgeEl = byId('kpiGradeBadge');
    if (badgeEl) {
      badgeEl.className = 'grade-badge ' + grade.badgeClass;
      badgeEl.textContent = grade.fullLabel;
    }

    var barEl = byId('kpiSurvivalBar');
    if (barEl) {
      barEl.style.width = Math.max(2, Math.min(100, activeSim.survivalRate)) + '%';
      barEl.style.backgroundColor = grade.color;
    }

    var descEl = byId('kpiGradeDesc');
    if (descEl) {
      descEl.textContent = grade.description;
    }

    // 첫해 -30% 폭락장 비교 배너
    var shockBanner = byId('shockComparisonBanner');
    if (shockBanner) {
      if (shockEnabled && latestShockSim) {
        var diff = latestShockSim.survivalRate - latestBaseSim.survivalRate;
        var diffSign = diff > 0 ? '+' : '';
        shockBanner.classList.add('is-visible');
        shockBanner.textContent =
          '은퇴 첫해 -30% 폭락 비교: 평시 생존확률 ' +
          Formatters.formatPercent(latestBaseSim.survivalRate, 1) +
          ' → 폭락 시 ' +
          Formatters.formatPercent(latestShockSim.survivalRate, 1) +
          ' (' + diffSign + diff.toFixed(1) + '%p 변화)';
      } else {
        shockBanner.classList.remove('is-visible');
        shockBanner.textContent = '';
      }
    }

    // KPI 카드 1: 은퇴 시점 예상 순자산 (P50)
    var retireVal = useRealValuation ? activeSim.retireMedianReal : activeSim.retireMedianNominal;
    var retireSubVal = useRealValuation ? activeSim.retireMedianNominal : activeSim.retireMedianReal;
    var kpiRetire = byId('kpiRetireMedian');
    var kpiRetireSub = byId('kpiRetireMedianSub');
    if (kpiRetire) kpiRetire.textContent = Formatters.formatManwon(retireVal);
    if (kpiRetireSub) {
      kpiRetireSub.textContent = useRealValuation
        ? '명목 금액 약 ' + Formatters.formatManwon(retireSubVal)
        : '현재가치 환산 약 ' + Formatters.formatManwon(retireSubVal);
    }

    // KPI 카드 2: 은퇴 첫해 초기 인출률
    var netMonthly = Math.max(0, cleanParams.monthlyExpense - cleanParams.monthlyExtraIncome);
    var kpiWr = byId('kpiWithdrawalRate');
    var kpiWrSub = byId('kpiWithdrawalSub');
    if (kpiWr) {
      kpiWr.textContent = Formatters.formatPercent(latestBaseSim.initialWithdrawalRate, 2);
    }
    if (kpiWrSub) {
      kpiWrSub.textContent = '순인출 월 ' + Formatters.formatManwon(netMonthly) + ' (현재가치)';
    }

    // KPI 카드 3: 기대수명 시점 중앙값 (P50) 또는 고갈 예상 연령
    var finalVal = useRealValuation ? activeSim.finalMedianReal : activeSim.finalMedianNominal;
    var kpiFinal = byId('kpiFinalMedian');
    var kpiDeplSub = byId('kpiDepletionSub');
    if (kpiFinal) {
      kpiFinal.textContent = Formatters.formatManwon(finalVal);
    }
    if (kpiDeplSub) {
      if (activeSim.medianDepletionAge !== null) {
        kpiDeplSub.textContent = '중앙값 기준 약 ' + activeSim.medianDepletionAge + '세 자산 소진';
      } else if (activeSim.p10DepletionAge !== null) {
        kpiDeplSub.textContent = '중앙값 유지 (하위 10%는 ' + activeSim.p10DepletionAge + '세 소진)';
      } else {
        kpiDeplSub.textContent = cleanParams.targetAge + '세까지 하위 10% 경로도 생존';
      }
    }

    // 팬차트 및 백분위수 표 업데이트
    var chartCanvas = byId('fanChartCanvas');
    if (fanChartController && chartCanvas) {
      fanChartController.update(latestBaseSim, latestShockSim, useRealValuation).catch(function () {
        drawNativeFallbackFanChart(chartCanvas, latestBaseSim, latestShockSim, useRealValuation);
      });
    }

    renderMilestoneTable(activeSim, useRealValuation);

    // 로컬 상태 저장 및 심화 링크 갱신
    StateCodec.saveLocal(cleanParams, {
      shockEnabled: shockEnabled,
      hideAmounts: hideAmountsShare
    });
    syncStressTestLink(cleanParams);

    // 3단계 바이럴 모듈 등이 구독할 수 있도록 커스텀 이벤트 발행
    if (typeof window.CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('fire:simulation-updated', {
        detail: getLatestAppState()
      }));
    }
  }

  /**
   * 외부 모듈(3단계 Canvas 카드 · 카카오 공유 등) 참조용 상태 스냅샷 반환
   */
  function getLatestAppState() {
    return {
      params: sliderController ? sliderController.getParams() : Engine.DEFAULT_PARAMS,
      baseSim: latestBaseSim,
      shockSim: latestShockSim,
      shockEnabled: shockEnabled,
      hideAmounts: hideAmountsShare,
      useRealValuation: useRealValuation
    };
  }

  /**
   * 클립보드 복사 유틸리티 (구형 브라우저 폴백 포함)
   */
  function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve();
        else reject(new Error('복사 실패'));
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * DOM 초기화
   */
  function initMainApp() {
    var initialParams = Object.assign({}, Engine.DEFAULT_PARAMS);
    var decodedFromHash = StateCodec.decodeHash(window.location.hash);
    var loadedFromLocal = StateCodec.loadLocal();

    var sharedBanner = byId('sharedStateBanner');
    var sharedMsg = byId('sharedStateMessage');

    if (decodedFromHash) {
      initialParams = decodedFromHash.params;
      shockEnabled = decodedFromHash.shockEnabled;
      hideAmountsShare = decodedFromHash.hideAmounts;

      if (sharedBanner && sharedMsg) {
        sharedBanner.classList.add('is-visible');
        sharedMsg.textContent = decodedFromHash.hideAmounts
          ? '공유된 시뮬레이션 조건(자산 총액 비공개 · 인출률 기준 정규화)이 적용되었습니다. 내 자산 숫자로 자유롭게 조정해 보세요.'
          : '공유 링크의 시뮬레이션 조건이 적용되었습니다. 슬라이더를 움직여 내 은퇴 계획과 비교해 보세요.';
      }
    } else if (loadedFromLocal) {
      initialParams = loadedFromLocal.params;
      shockEnabled = loadedFromLocal.shockEnabled;
      hideAmountsShare = loadedFromLocal.hideAmounts;
    }

    var shockToggleEl = byId('toggleFirstYearShock');
    if (shockToggleEl) {
      shockToggleEl.checked = shockEnabled;
    }

    var hideToggleEl = byId('toggleHideAmountsShare');
    if (hideToggleEl) {
      hideToggleEl.checked = hideAmountsShare;
    }

    var chartCanvas = byId('fanChartCanvas');
    if (chartCanvas) {
      fanChartController = UICore.createFanChartController(chartCanvas);
    }

    // 10개 입력 필드 바인딩 설정
    var fieldConfigs = [
      {
        key: 'currentNetWorth',
        sliderEl: byId('sliderCurrentNetWorth'),
        inputEl: byId('inputCurrentNetWorth'),
        formattedEl: byId('fmtCurrentNetWorth'),
        formatter: function (v) { return Formatters.formatManwon(v); }
      },
      {
        key: 'monthlySaving',
        sliderEl: byId('sliderMonthlySaving'),
        inputEl: byId('inputMonthlySaving'),
        formattedEl: byId('fmtMonthlySaving'),
        formatter: function (v) { return Formatters.formatManwon(v); }
      },
      {
        key: 'currentAge',
        sliderEl: byId('sliderCurrentAge'),
        inputEl: byId('inputCurrentAge'),
        formattedEl: byId('fmtCurrentAge'),
        formatter: function (v) { return v + '세'; }
      },
      {
        key: 'retireAge',
        sliderEl: byId('sliderRetireAge'),
        inputEl: byId('inputRetireAge'),
        formattedEl: byId('fmtRetireAge'),
        formatter: function (v, st) {
          var diff = Math.max(0, v - st.currentAge);
          return diff === 0 ? v + '세 (즉시 은퇴)' : v + '세 (' + diff + '년 후)';
        }
      },
      {
        key: 'targetAge',
        sliderEl: byId('sliderTargetAge'),
        inputEl: byId('inputTargetAge'),
        formattedEl: byId('fmtTargetAge'),
        formatter: function (v, st) {
          var span = Math.max(1, v - st.retireAge);
          return v + '세 (은퇴기간 ' + span + '년)';
        }
      },
      {
        key: 'monthlyExpense',
        sliderEl: byId('sliderMonthlyExpense'),
        inputEl: byId('inputMonthlyExpense'),
        formattedEl: byId('fmtMonthlyExpense'),
        formatter: function (v) { return Formatters.formatManwon(v); }
      },
      {
        key: 'monthlyExtraIncome',
        sliderEl: byId('sliderMonthlyExtraIncome'),
        inputEl: byId('inputMonthlyExtraIncome'),
        formattedEl: byId('fmtMonthlyExtraIncome'),
        formatter: function (v) { return Formatters.formatManwon(v); }
      },
      {
        key: 'expectedReturn',
        sliderEl: byId('sliderExpectedReturn'),
        inputEl: byId('inputExpectedReturn'),
        formattedEl: byId('fmtExpectedReturn'),
        formatter: function (v) { return Number(v).toFixed(1) + '%'; }
      },
      {
        key: 'volatility',
        sliderEl: byId('sliderVolatility'),
        inputEl: byId('inputVolatility'),
        formattedEl: byId('fmtVolatility'),
        formatter: function (v) { return Number(v).toFixed(1) + '%'; }
      },
      {
        key: 'inflation',
        sliderEl: byId('sliderInflation'),
        inputEl: byId('inputInflation'),
        formattedEl: byId('fmtInflation'),
        formatter: function (v) { return Number(v).toFixed(1) + '%'; }
      }
    ];

    sliderController = UICore.bindSliderGroup(fieldConfigs, initialParams, function (updatedParams) {
      recalculateAndRender(updatedParams);
    });

    // 포트폴리오 프리셋 클릭 이벤트
    document.querySelectorAll('.preset-btn[data-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-preset');
        var preset = Engine.PORTFOLIO_PRESETS[key];
        if (!preset) return;
        sliderController.setParams({
          expectedReturn: preset.expectedReturn,
          volatility: preset.volatility
        }, true);
      });
    });

    // 첫해 -30% 폭락장 토글 이벤트
    if (shockToggleEl) {
      shockToggleEl.addEventListener('change', function () {
        shockEnabled = Boolean(shockToggleEl.checked);
        recalculateAndRender(sliderController.getParams());
      });
    }

    // 현재가치 / 명목가치 보기 전환
    var btnReal = byId('btnViewReal');
    var btnNominal = byId('btnViewNominal');
    if (btnReal && btnNominal) {
      btnReal.addEventListener('click', function () {
        if (useRealValuation) return;
        useRealValuation = true;
        btnReal.classList.add('is-active');
        btnNominal.classList.remove('is-active');
        recalculateAndRender(sliderController.getParams());
      });
      btnNominal.addEventListener('click', function () {
        if (!useRealValuation) return;
        useRealValuation = false;
        btnNominal.classList.add('is-active');
        btnReal.classList.remove('is-active');
        recalculateAndRender(sliderController.getParams());
      });
    }

    // 새 난수 재추첨 버튼
    var btnReseed = byId('btnReseedRandom');
    if (btnReseed) {
      btnReseed.addEventListener('click', function () {
        currentSeed = Math.floor(Math.random() * 2000000000) + 1;
        recalculateAndRender(sliderController.getParams());
      });
    }

    // 초기화 버튼 (입력 패널 & 공유 배너)
    function resetToDefaults() {
      shockEnabled = false;
      hideAmountsShare = false;
      if (shockToggleEl) shockToggleEl.checked = false;
      if (hideToggleEl) hideToggleEl.checked = false;
      if (sharedBanner) sharedBanner.classList.remove('is-visible');
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      sliderController.setParams(Engine.DEFAULT_PARAMS, true);
    }

    var btnReset = byId('btnResetDefaults');
    if (btnReset) btnReset.addEventListener('click', resetToDefaults);
    var btnResetTop = byId('btnResetDefaultTop');
    if (btnResetTop) btnResetTop.addEventListener('click', resetToDefaults);

    // 자산 숨김 공유 체크박스 변경
    if (hideToggleEl) {
      hideToggleEl.addEventListener('change', function () {
        hideAmountsShare = Boolean(hideToggleEl.checked);
        StateCodec.saveLocal(sliderController.getParams(), {
          shockEnabled: shockEnabled,
          hideAmounts: hideAmountsShare
        });
      });
    }

    // URL 해시 링크 복사 버튼
    var btnCopyUrl = byId('btnCopyShareUrl');
    if (btnCopyUrl) {
      btnCopyUrl.addEventListener('click', function () {
        var params = sliderController.getParams();
        var hash = StateCodec.encodeHash(params, {
          shockEnabled: shockEnabled,
          hideAmounts: hideAmountsShare,
          initialWithdrawalRate: latestBaseSim ? latestBaseSim.initialWithdrawalRate : 4.0
        });
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', window.location.pathname + window.location.search + hash);
        }
        var shareUrl = window.location.origin && window.location.origin !== 'null'
          ? window.location.origin + window.location.pathname + window.location.search + hash
          : window.location.href.split('#')[0] + hash;

        copyTextToClipboard(shareUrl).then(function () {
          var toast = byId('copyToastMsg');
          if (toast) {
            toast.textContent = hideAmountsShare
              ? '자산 금액을 숨긴 공유 링크가 복사되었습니다!'
              : '시뮬레이션 공유 링크가 복사되었습니다!';
            toast.classList.add('is-visible');
            if (copyToastTimer) clearTimeout(copyToastTimer);
            copyToastTimer = setTimeout(function () {
              toast.classList.remove('is-visible');
            }, 2800);
          }
        });
      });
    }

    // 브라우저 뒤로가기/해시 변경 대응
    window.addEventListener('hashchange', function () {
      var decoded = StateCodec.decodeHash(window.location.hash);
      if (decoded) {
        shockEnabled = decoded.shockEnabled;
        hideAmountsShare = decoded.hideAmounts;
        if (shockToggleEl) shockToggleEl.checked = shockEnabled;
        if (hideToggleEl) hideToggleEl.checked = hideAmountsShare;
        sliderController.setParams(decoded.params, true);
      }
    });

    // 최초 1회 즉시 시뮬레이션 렌더링
    recalculateAndRender(initialParams);
  }

  window.FireMainApp = {
    getLatestState: getLatestAppState
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMainApp);
  } else {
    initMainApp();
  }
})();
