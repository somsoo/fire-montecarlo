/**
 * 파이어족(FIRE) 몬테카를로 은퇴 생존확률 시뮬레이터 — 공용 UI · 차트 · Canvas · jsPDF 모듈 (ui-core.js)
 *
 * 포함 모듈:
 * 1. Formatters        : 만원 단위 한국어 금액 변환(억/만원), 축 라벨, 퍼센트 포맷터
 * 2. StateCodec        : URL 해시(#s=...) 압축 직렬화/복원(자산 숨김 모드 지원) 및 localStorage 관리
 * 3. SliderInputSync   : 슬라이더-숫자입력 양방향 동기화 및 연령 제약 자동 보정
 * 4. ScriptLoader      : Chart.js / jsPDF / Kakao SDK 중복 방지 지연 로더
 * 5. FanChartController: Chart.js P10~P90 백분위수 팬차트 + 은퇴선 플러그인 + 첫해 폭락 비교선
 * 6. CanvasCardBase    : 1080x1920 9:16 인증샷 빌더용 도형·텍스트·미니차트·PNG 추출 기반 모듈
 * 7. PdfReportBase     : 한글 폰트 깨짐 없는 고해상도 Canvas 기반 jsPDF A4 진단서 생성 모듈
 * 8. WorkerClient      : Web Worker 비동기 호출 브리지 (로컬 file:// 환경 자동 폴백 포함)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var engine = require('./montecarlo-engine.js');
    module.exports = factory(engine);
  } else {
    root.FireUICore = factory(root.MonteCarloEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (MonteCarloEngine) {
  'use strict';

  var STORAGE_KEY = 'kr_fire_mc_state_v1';
  var CDN_URLS = {
    chartJs: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js',
    jsPdf: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
    kakaoSdk: 'https://t1.kakaocdn.net/kakao_js_sdk/2.7.2/kakao.min.js'
  };

  /* ========================================================================
   * 1. Formatters — 한국어 금액 · 수치 포맷 유틸리티
   * ======================================================================== */
  var Formatters = {
    /**
     * 만원 단위 숫자를 읽기 쉬운 한국어 화폐 표기로 변환 (예: 35000 -> "3억 5,000만 원")
     */
    formatManwon: function (manwon, includeWonSuffix) {
      var suffix = includeWonSuffix === false ? '' : ' 원';
      var val = Math.round(Number(manwon) || 0);
      var isNeg = val < 0;
      var abs = Math.abs(val);

      if (abs === 0) {
        return '0만' + suffix;
      }

      var jo = Math.floor(abs / 100000000);
      var remAfterJo = abs % 100000000;
      var eok = Math.floor(remAfterJo / 10000);
      var man = remAfterJo % 10000;

      var parts = [];
      if (jo > 0) parts.push(jo.toLocaleString('ko-KR') + '조');
      if (eok > 0) parts.push(eok.toLocaleString('ko-KR') + '억');
      if (man > 0) parts.push(man.toLocaleString('ko-KR') + '만');

      return (isNeg ? '-' : '') + parts.join(' ') + suffix;
    },

    /**
     * 차트 Y축 눈금용 짧은 금액 포맷터 (예: 35000 -> "3.5억", 8000 -> "8,000만")
     */
    formatAxisManwon: function (manwon) {
      var val = Number(manwon) || 0;
      var abs = Math.abs(val);
      var sign = val < 0 ? '-' : '';
      if (abs === 0) return '0';
      if (abs >= 100000000) {
        return sign + (abs / 100000000).toFixed(1).replace(/\.0$/, '') + '조';
      }
      if (abs >= 10000) {
        var eok = abs / 10000;
        var digits = eok >= 100 ? 0 : 1;
        return sign + eok.toFixed(digits).replace(/\.0$/, '') + '억';
      }
      return sign + Math.round(abs).toLocaleString('ko-KR') + '만';
    },

    formatPercent: function (val, fractionDigits) {
      var d = typeof fractionDigits === 'number' ? fractionDigits : 1;
      var num = Number(val) || 0;
      return num.toFixed(d) + '%';
    }
  };

  /* ========================================================================
   * 2. StateCodec — URL 해시(#s=...) 압축 및 localStorage 상태 관리
   * ======================================================================== */
  function toBase64Url(str) {
    var b64;
    if (typeof btoa === 'function') {
      b64 = btoa(str);
    } else if (typeof Buffer !== 'undefined') {
      b64 = Buffer.from(str, 'utf8').toString('base64');
    } else {
      return encodeURIComponent(str);
    }
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(b64url) {
    var b64 = String(b64url).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) {
      b64 += '=';
    }
    if (typeof atob === 'function') {
      return atob(b64);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(b64, 'base64').toString('utf8');
    }
    return decodeURIComponent(b64url);
  }

  var StateCodec = {
    /**
     * 입력 상태를 짧은 URL 해시 문자열(#s=...)로 압축
     * @param {Object} rawParams 시뮬레이션 파라미터
     * @param {Object} [flags] { shockEnabled: boolean, hideAmounts: boolean, initialWithdrawalRate?: number }
     */
    encodeHash: function (rawParams, flags) {
      var p = MonteCarloEngine.sanitizeParams(rawParams);
      var f = flags || {};
      var shockFlag = f.shockEnabled ? 1 : 0;
      var hideFlag = f.hideAmounts ? 1 : 0;

      var payload;
      if (hideFlag === 1) {
        // 자산 총액 숨김 모드: 실제 순자산·생활비 금액을 URL에 포함하지 않고
        // 기준 자산 1억(10,000만 원) 대비 초기 인출률 비율만 정규화하여 전달
        var ratePct = typeof f.initialWithdrawalRate === 'number' && f.initialWithdrawalRate > 0
          ? Number(f.initialWithdrawalRate.toFixed(2))
          : 4.0;
        var normExpense = Number(((10000 * (ratePct / 100)) / 12).toFixed(1));
        payload = [
          'v1p',
          10000,
          0,
          p.currentAge,
          p.retireAge,
          p.targetAge,
          normExpense,
          0,
          p.expectedReturn,
          p.volatility,
          p.inflation,
          shockFlag,
          1
        ].join(',');
      } else {
        payload = [
          'v1',
          p.currentNetWorth,
          p.monthlySaving,
          p.currentAge,
          p.retireAge,
          p.targetAge,
          p.monthlyExpense,
          p.monthlyExtraIncome,
          p.expectedReturn,
          p.volatility,
          p.inflation,
          shockFlag,
          0
        ].join(',');
      }

      return '#s=' + toBase64Url(payload);
    },

    /**
     * URL 해시 문자열(#s=...)로부터 입력 상태 복원
     * @param {string} hashStr window.location.hash
     * @returns {Object|null} { params, shockEnabled, hideAmounts } 또는 null
     */
    decodeHash: function (hashStr) {
      if (!hashStr || typeof hashStr !== 'string') return null;
      var cleaned = hashStr.replace(/^#/, '');
      var match = /(?:^|&)s=([^&]+)/.exec(cleaned);
      if (!match || !match[1]) return null;

      try {
        var raw = fromBase64Url(match[1]);
        var parts = raw.split(',');
        if (parts.length < 13 || (parts[0] !== 'v1' && parts[0] !== 'v1p')) {
          return null;
        }
        var params = MonteCarloEngine.sanitizeParams({
          currentNetWorth: Number(parts[1]),
          monthlySaving: Number(parts[2]),
          currentAge: Number(parts[3]),
          retireAge: Number(parts[4]),
          targetAge: Number(parts[5]),
          monthlyExpense: Number(parts[6]),
          monthlyExtraIncome: Number(parts[7]),
          expectedReturn: Number(parts[8]),
          volatility: Number(parts[9]),
          inflation: Number(parts[10])
        });
        return {
          params: params,
          shockEnabled: parts[11] === '1',
          hideAmounts: parts[12] === '1' || parts[0] === 'v1p'
        };
      } catch (_e) {
        return null;
      }
    },

    saveLocal: function (params, flags) {
      if (typeof localStorage === 'undefined') return;
      try {
        var record = {
          params: MonteCarloEngine.sanitizeParams(params),
          shockEnabled: Boolean(flags && flags.shockEnabled),
          hideAmounts: Boolean(flags && flags.hideAmounts),
          updatedAt: Date.now()
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
      } catch (_e) {
        // 사생활 보호 모드 등 스토리지 제한 무시
      }
    },

    loadLocal: function () {
      if (typeof localStorage === 'undefined') return null;
      try {
        var text = localStorage.getItem(STORAGE_KEY);
        if (!text) return null;
        var parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || !parsed.params) return null;
        return {
          params: MonteCarloEngine.sanitizeParams(parsed.params),
          shockEnabled: Boolean(parsed.shockEnabled),
          hideAmounts: Boolean(parsed.hideAmounts)
        };
      } catch (_e) {
        return null;
      }
    }
  };

  /* ========================================================================
   * 3. ScriptLoader — 외부 라이브러리 중복 방지 지연 로더
   * ======================================================================== */
  var scriptPromises = {};

  function loadScriptOnce(src, checkGlobalFn, timeoutMs) {
    if (typeof checkGlobalFn === 'function' && checkGlobalFn()) {
      return Promise.resolve();
    }
    if (scriptPromises[src]) {
      return scriptPromises[src];
    }
    if (typeof document === 'undefined') {
      return Promise.reject(new Error('브라우저 환경이 아닙니다.'));
    }

    scriptPromises[src] = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      var timer = setTimeout(function () {
        delete scriptPromises[src];
        reject(new Error('스크립트 로드 시간 초과: ' + src));
      }, timeoutMs || 8000);

      script.onload = function () {
        clearTimeout(timer);
        resolve();
      };
      script.onerror = function () {
        clearTimeout(timer);
        delete scriptPromises[src];
        reject(new Error('스크립트 로드 실패: ' + src));
      };
      document.head.appendChild(script);
    });

    return scriptPromises[src];
  }

  /* ========================================================================
   * 4. SliderInputSync — 슬라이더 · 숫자 입력 양방향 바인딩
   * ======================================================================== */
  function bindSliderGroup(fieldConfigs, initialParams, onChangeCallback) {
    var state = MonteCarloEngine.sanitizeParams(initialParams);
    var rafId = null;
    var elementsByKey = {};

    function refreshFieldDisplay(key) {
      var cfg = elementsByKey[key];
      if (!cfg) return;
      var val = state[key];
      if (cfg.sliderEl && String(cfg.sliderEl.value) !== String(val)) {
        cfg.sliderEl.value = val;
      }
      if (cfg.inputEl && document.activeElement !== cfg.inputEl) {
        cfg.inputEl.value = val;
      }
      if (cfg.formattedEl && typeof cfg.formatter === 'function') {
        cfg.formattedEl.textContent = cfg.formatter(val, state);
      }
    }

    function enforceAgeOrder(changedKey) {
      if (changedKey === 'currentAge') {
        if (state.retireAge < state.currentAge) state.retireAge = state.currentAge;
        if (state.targetAge <= state.retireAge) state.targetAge = state.retireAge + 1;
      } else if (changedKey === 'retireAge') {
        if (state.retireAge < state.currentAge) state.currentAge = state.retireAge;
        if (state.targetAge <= state.retireAge) state.targetAge = state.retireAge + 1;
      } else if (changedKey === 'targetAge') {
        if (state.targetAge <= state.retireAge) state.retireAge = Math.max(state.currentAge, state.targetAge - 1);
        if (state.currentAge > state.retireAge) state.currentAge = state.retireAge;
      }
      refreshFieldDisplay('currentAge');
      refreshFieldDisplay('retireAge');
      refreshFieldDisplay('targetAge');
    }

    function scheduleNotify() {
      if (typeof onChangeCallback !== 'function') return;
      if (typeof requestAnimationFrame === 'function') {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(function () {
          rafId = null;
          onChangeCallback(MonteCarloEngine.sanitizeParams(state));
        });
      } else {
        onChangeCallback(MonteCarloEngine.sanitizeParams(state));
      }
    }

    fieldConfigs.forEach(function (cfg) {
      elementsByKey[cfg.key] = cfg;
      refreshFieldDisplay(cfg.key);

      if (cfg.sliderEl) {
        cfg.sliderEl.addEventListener('input', function () {
          state[cfg.key] = Number(cfg.sliderEl.value);
          if (cfg.inputEl) cfg.inputEl.value = state[cfg.key];
          enforceAgeOrder(cfg.key);
          refreshFieldDisplay(cfg.key);
          scheduleNotify();
        });
      }

      if (cfg.inputEl) {
        cfg.inputEl.addEventListener('input', function () {
          if (cfg.inputEl.value === '' || cfg.inputEl.value === '-') return;
          var parsed = Number(cfg.inputEl.value);
          if (!Number.isFinite(parsed)) return;
          state[cfg.key] = parsed;
          if (cfg.sliderEl) cfg.sliderEl.value = parsed;
          enforceAgeOrder(cfg.key);
          if (cfg.formattedEl && typeof cfg.formatter === 'function') {
            cfg.formattedEl.textContent = cfg.formatter(state[cfg.key], state);
          }
          scheduleNotify();
        });

        cfg.inputEl.addEventListener('blur', function () {
          state = MonteCarloEngine.sanitizeParams(state);
          Object.keys(elementsByKey).forEach(refreshFieldDisplay);
          scheduleNotify();
        });
      }
    });

    return {
      getParams: function () {
        return MonteCarloEngine.sanitizeParams(state);
      },
      setParams: function (nextParams, triggerChange) {
        state = MonteCarloEngine.sanitizeParams(Object.assign({}, state, nextParams));
        Object.keys(elementsByKey).forEach(refreshFieldDisplay);
        if (triggerChange !== false) {
          scheduleNotify();
        }
      }
    };
  }

  /* ========================================================================
   * 5. FanChartController — Chart.js 백분위수 팬차트 및 생존곡선 컨트롤러
   * ======================================================================== */
  var retireLinePlugin = {
    id: 'fireRetireMarker',
    afterDatasetsDraw: function (chart, _args, pluginOptions) {
      if (!pluginOptions || typeof pluginOptions.retireIndex !== 'number') return;
      var idx = pluginOptions.retireIndex;
      var xScale = chart.scales.x;
      var yScale = chart.scales.y;
      if (!xScale || !yScale || idx < 0 || idx >= chart.data.labels.length) return;

      var xPos = xScale.getPixelForValue(idx);
      var ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = pluginOptions.color || '#475569';
      ctx.moveTo(xPos, yScale.top);
      ctx.lineTo(xPos, yScale.bottom);
      ctx.stroke();

      if (pluginOptions.label) {
        ctx.fillStyle = pluginOptions.color || '#1e293b';
        ctx.font = '600 11px Pretendard, sans-serif';
        ctx.textAlign = idx > chart.data.labels.length * 0.75 ? 'right' : 'left';
        var offsetX = idx > chart.data.labels.length * 0.75 ? -6 : 6;
        ctx.fillText(pluginOptions.label, xPos + offsetX, yScale.top + 14);
      }
      ctx.restore();
    }
  };

  function createFanChartController(canvasEl) {
    var chartInstance = null;

    function ensureChartJs() {
      return loadScriptOnce(CDN_URLS.chartJs, function () {
        return typeof window !== 'undefined' && typeof window.Chart !== 'undefined';
      });
    }

    function update(simResult, shockSimResult, useRealValue) {
      return ensureChartJs().then(function () {
        var Chart = window.Chart;
        var pSet = useRealValue !== false ? simResult.percentilesReal : simResult.percentilesNominal;
        var labels = simResult.ages.map(function (age) { return age + '세'; });

        var datasets = [
          {
            label: '상위 10% (P90)',
            data: pSet.p90,
            borderColor: 'rgba(37, 99, 235, 0.22)',
            backgroundColor: 'rgba(37, 99, 235, 0.08)',
            borderWidth: 1,
            pointRadius: 0,
            fill: '+4',
            tension: 0.25
          },
          {
            label: '상위 25% (P75)',
            data: pSet.p75,
            borderColor: 'rgba(37, 99, 235, 0.35)',
            backgroundColor: 'rgba(37, 99, 235, 0.16)',
            borderWidth: 1,
            pointRadius: 0,
            fill: '+2',
            tension: 0.25
          },
          {
            label: '중앙값 (P50)',
            data: pSet.p50,
            borderColor: '#1d4ed8',
            backgroundColor: 'transparent',
            borderWidth: 2.8,
            pointRadius: 0,
            fill: false,
            tension: 0.25
          },
          {
            label: '하위 25% (P25)',
            data: pSet.p25,
            borderColor: 'rgba(37, 99, 235, 0.35)',
            backgroundColor: 'transparent',
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            tension: 0.25
          },
          {
            label: '하위 10% (P10)',
            data: pSet.p10,
            borderColor: 'rgba(37, 99, 235, 0.22)',
            backgroundColor: 'transparent',
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            tension: 0.25
          }
        ];

        if (shockSimResult) {
          var shockSet = useRealValue !== false ? shockSimResult.percentilesReal : shockSimResult.percentilesNominal;
          datasets.push({
            label: '첫해 -30% 폭락 시 중앙값(P50)',
            data: shockSet.p50,
            borderColor: '#e11d48',
            backgroundColor: 'transparent',
            borderDash: [6, 4],
            borderWidth: 2.5,
            pointRadius: 0,
            fill: false,
            tension: 0.25
          });
        }

        var markerOptions = {
          retireIndex: simResult.retireStep,
          label: '은퇴 시작 (' + simResult.params.retireAge + '세)',
          color: '#334155'
        };

        if (chartInstance) {
          chartInstance.data.labels = labels;
          chartInstance.data.datasets = datasets;
          chartInstance.options.plugins.fireRetireMarker = markerOptions;
          chartInstance.update('none');
          return chartInstance;
        }

        chartInstance = new Chart(canvasEl.getContext('2d'), {
          type: 'line',
          data: {
            labels: labels,
            datasets: datasets
          },
          plugins: [retireLinePlugin],
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 220 },
            interaction: {
              mode: 'index',
              intersect: false
            },
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  boxWidth: 14,
                  font: { size: 11 }
                }
              },
              tooltip: {
                callbacks: {
                  label: function (ctx) {
                    return ctx.dataset.label + ': ' + Formatters.formatManwon(ctx.parsed.y);
                  }
                }
              },
              fireRetireMarker: markerOptions
            },
            scales: {
              x: {
                grid: { display: false },
                ticks: { maxTicksLimit: 10 }
              },
              y: {
                beginAtZero: true,
                ticks: {
                  callback: function (value) {
                    return Formatters.formatAxisManwon(value);
                  }
                }
              }
            }
          }
        });

        return chartInstance;
      });
    }

    return {
      update: update,
      destroy: function () {
        if (chartInstance) {
          chartInstance.destroy();
          chartInstance = null;
        }
      }
    };
  }

  /* ========================================================================
   * 6. CanvasCardBase — 1080x1920 9:16 인증샷 Canvas 드로잉 기반 유틸리티
   * ======================================================================== */
  var CanvasCardBase = {
    WIDTH: 1080,
    HEIGHT: 1920,

    createCanvas: function (existingCanvas) {
      var canvas = existingCanvas || document.createElement('canvas');
      canvas.width = CanvasCardBase.WIDTH;
      canvas.height = CanvasCardBase.HEIGHT;
      return canvas;
    },

    drawRoundRect: function (ctx, x, y, w, h, radius) {
      var r = Math.min(radius, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    },

    drawMiniFanSilhouette: function (ctx, box, percentiles, shockP50) {
      var p10 = percentiles.p10;
      var p25 = percentiles.p25;
      var p50 = percentiles.p50;
      var p75 = percentiles.p75;
      var p90 = percentiles.p90;
      var count = p50.length;
      if (count < 2) return;

      var maxVal = 1;
      for (var i = 0; i < count; i++) {
        if (p90[i] > maxVal) maxVal = p90[i];
      }

      function mapX(idx) {
        return box.x + (idx / (count - 1)) * box.w;
      }
      function mapY(val) {
        var clamped = Math.max(0, Math.min(maxVal, val));
        return box.y + box.h - (clamped / maxVal) * box.h;
      }

      function fillBand(upper, lower, fillStyle) {
        ctx.save();
        ctx.beginPath();
        for (var a = 0; a < count; a++) {
          var x = mapX(a);
          var y = mapY(upper[a]);
          if (a === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        for (var b = count - 1; b >= 0; b--) {
          ctx.lineTo(mapX(b), mapY(lower[b]));
        }
        ctx.closePath();
        ctx.fillStyle = fillStyle;
        ctx.fill();
        ctx.restore();
      }

      fillBand(p90, p10, 'rgba(59, 130, 246, 0.18)');
      fillBand(p75, p25, 'rgba(59, 130, 246, 0.30)');

      ctx.save();
      ctx.beginPath();
      for (var k = 0; k < count; k++) {
        if (k === 0) ctx.moveTo(mapX(k), mapY(p50[k]));
        else ctx.lineTo(mapX(k), mapY(p50[k]));
      }
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = 6;
      ctx.stroke();

      if (Array.isArray(shockP50) && shockP50.length === count) {
        ctx.beginPath();
        ctx.setLineDash([12, 8]);
        for (var s = 0; s < count; s++) {
          if (s === 0) ctx.moveTo(mapX(s), mapY(shockP50[s]));
          else ctx.lineTo(mapX(s), mapY(shockP50[s]));
        }
        ctx.strokeStyle = '#fb7185';
        ctx.lineWidth = 5;
        ctx.stroke();
      }
      ctx.restore();
    },

    toBlobPromise: function (canvas) {
      return new Promise(function (resolve, reject) {
        if (canvas.toBlob) {
          canvas.toBlob(function (blob) {
            if (blob) resolve(blob);
            else reject(new Error('Canvas 이미지 변환에 실패했습니다.'));
          }, 'image/png');
        } else {
          try {
            var dataUrl = canvas.toDataURL('image/png');
            var bin = atob(dataUrl.split(',')[1]);
            var arr = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            resolve(new Blob([arr], { type: 'image/png' }));
          } catch (e) {
            reject(e);
          }
        }
      });
    },

    downloadPng: function (canvas, filename) {
      return CanvasCardBase.toBlobPromise(canvas).then(function (blob) {
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = filename || 'fire-survival-card.png';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        return blob;
      });
    }
  };

  /* ========================================================================
   * 7. PdfReportBase — 한글 폰트 깨짐 없는 고해상도 Canvas -> jsPDF A4 빌더
   * ======================================================================== */
  var PdfReportBase = {
    PAGE_WIDTH_PX: 1240,
    PAGE_HEIGHT_PX: 1754,

    ensureJsPdf: function () {
      return loadScriptOnce(CDN_URLS.jsPdf, function () {
        return typeof window !== 'undefined' && window.jspdf && window.jspdf.jsPDF;
      });
    },

    /**
     * 페이지별 Canvas 드로잉 콜백 배열을 받아 A4 PDF 파일로 저장
     * 브라우저 시스템 한글 폰트로 오프스크린 Canvas에 렌더링한 뒤 이미지를 삽입하므로
     * 외부 대용량 TTF 폰트 다운로드 없이 한글·수치·표가 선명하게 출력된다.
     * @param {Array<function(CanvasRenderingContext2D, number, number): void>} pageDrawers
     * @param {string} filename 저장할 파일명
     */
    exportCanvasPagesToPdf: function (pageDrawers, filename) {
      return PdfReportBase.ensureJsPdf().then(function () {
        var jsPDF = window.jspdf.jsPDF;
        var doc = new jsPDF({
          orientation: 'portrait',
          unit: 'mm',
          format: 'a4',
          compress: true
        });

        pageDrawers.forEach(function (drawFn, pageIndex) {
          var pageCanvas = document.createElement('canvas');
          pageCanvas.width = PdfReportBase.PAGE_WIDTH_PX;
          pageCanvas.height = PdfReportBase.PAGE_HEIGHT_PX;
          var ctx = pageCanvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

          drawFn(ctx, pageCanvas.width, pageCanvas.height);

          var imgData = pageCanvas.toDataURL('image/jpeg', 0.92);
          if (pageIndex > 0) {
            doc.addPage('a4', 'portrait');
          }
          doc.addImage(imgData, 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
        });

        doc.save(filename || 'fire-retirement-report.pdf');
        return doc;
      });
    }
  };

  /* ========================================================================
   * 8. WorkerClient — Web Worker 브리지 (로컬 file:// 환경 비동기 폴백 포함)
   * ======================================================================== */
  function createWorkerClient(workerScriptUrl) {
    var worker = null;
    var workerFailed = false;
    var seq = 0;
    var pending = {};

    function ensureWorker() {
      if (workerFailed || typeof Worker === 'undefined') return null;
      if (worker) return worker;
      try {
        worker = new Worker(workerScriptUrl);
        worker.onmessage = function (ev) {
          var msg = ev.data || {};
          var entry = pending[msg.requestId];
          if (!entry) return;
          delete pending[msg.requestId];
          if (msg.ok) {
            entry.resolve(msg);
          } else {
            entry.reject(new Error(msg.error || 'Worker 연산 오류'));
          }
        };
        worker.onerror = function () {
          workerFailed = true;
          if (worker) {
            worker.terminate();
            worker = null;
          }
          Object.keys(pending).forEach(function (id) {
            var item = pending[id];
            delete pending[id];
            item.fallback();
          });
        };
        return worker;
      } catch (_e) {
        workerFailed = true;
        return null;
      }
    }

    function runFallbackAsync(type, params, options) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          if (type === 'RUN_SIMULATION') {
            resolve({
              ok: true,
              type: type,
              fallback: true,
              result: MonteCarloEngine.runSimulation(params, options)
            });
            return;
          }
          var iterations = (options && options.iterations) || 10000;
          var seed = options && typeof options.seed === 'number' ? options.seed : null;
          var base10k = MonteCarloEngine.runSimulation(params, { iterations: iterations, firstYearShock: null, seed: seed });
          var shock30 = MonteCarloEngine.runSimulation(params, { iterations: iterations, firstYearShock: -0.30, seed: seed });
          var stressMatrix = MonteCarloEngine.runStressMatrix(params, { iterations: iterations, seed: seed || 20261125 });
          var withdrawalCurve = MonteCarloEngine.runWithdrawalCurve(params, { iterations: iterations, seed: seed || 20261125 });
          var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          resolve({
            ok: true,
            type: 'RUN_STRESS_SUITE',
            fallback: true,
            totalElapsedMs: Number((t1 - t0).toFixed(2)),
            result: {
              base10k: base10k,
              shock30: shock30,
              stressMatrix: stressMatrix,
              withdrawalCurve: withdrawalCurve
            }
          });
        }, 16);
      });
    }

    return {
      runStressSuite: function (params, options) {
        var w = ensureWorker();
        if (!w) {
          return runFallbackAsync('RUN_STRESS_SUITE', params, options);
        }
        return new Promise(function (resolve, reject) {
          var requestId = ++seq;
          pending[requestId] = {
            resolve: resolve,
            reject: reject,
            fallback: function () {
              runFallbackAsync('RUN_STRESS_SUITE', params, options).then(resolve, reject);
            }
          };
          w.postMessage({
            requestId: requestId,
            type: 'RUN_STRESS_SUITE',
            params: params,
            options: options || { iterations: 10000 }
          });
        });
      },
      terminate: function () {
        if (worker) {
          worker.terminate();
          worker = null;
        }
      }
    };
  }

  return {
    CDN_URLS: CDN_URLS,
    Formatters: Formatters,
    StateCodec: StateCodec,
    loadScriptOnce: loadScriptOnce,
    bindSliderGroup: bindSliderGroup,
    createFanChartController: createFanChartController,
    CanvasCardBase: CanvasCardBase,
    PdfReportBase: PdfReportBase,
    createWorkerClient: createWorkerClient
  };
});
