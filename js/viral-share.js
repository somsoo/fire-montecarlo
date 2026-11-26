/**
 * 파이어족(FIRE) 몬테카를로 은퇴 생존확률 시뮬레이터 — 3단계 바이럴 공유 모듈 (viral-share.js)
 *
 * 담당 기능:
 * 1. HTML5 Canvas 1080x1920 (9:16 인스타 스토리·쓰레드 규격) 은퇴 생존확률 등급 인증샷 렌더링
 * 2. 자산 총액 숨김 토글(프라이버시 모드) — 순자산·생활비 실금액 노출 없이 비율·등급·은퇴나이만 표시
 * 3. PNG 이미지 저장, 모바일 Web Share API 파일 공유, 인증 문구 복사
 * 4. 카카오톡 공유 SDK (Kakao.Share.sendDefault) 연동 + 등급별 정적 OG 이미지 + URL 해시 압축
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var engine = require('./montecarlo-engine.js');
    var uiCore = require('./ui-core.js');
    module.exports = factory(engine, uiCore);
  } else {
    root.FireViralShare = factory(root.MonteCarloEngine, root.FireUICore);
  }
})(typeof self !== 'undefined' ? self : this, function (Engine, UICore) {
  'use strict';

  var Formatters = UICore.Formatters;
  var StateCodec = UICore.StateCodec;
  var CanvasCardBase = UICore.CanvasCardBase;

  /** 등급 코드별 정적 OG 이미지 매핑 */
  var GRADE_OG_ASSETS = Object.freeze({
    SAFE: 'assets/og-safe.png',
    MODERATE: 'assets/og-moderate.png',
    CAUTION: 'assets/og-caution.png',
    RISK: 'assets/og-risk.png'
  });

  /** 등급별 9:16 카드 컬러 팔레트 */
  var CARD_THEMES = Object.freeze({
    SAFE: {
      bgTop: '#06281e',
      bgBottom: '#0f172a',
      accent: '#10b981',
      badgeBg: 'rgba(16, 185, 129, 0.20)',
      badgeBorder: '#34d399'
    },
    MODERATE: {
      bgTop: '#0f2557',
      bgBottom: '#0f172a',
      accent: '#3b82f6',
      badgeBg: 'rgba(59, 130, 246, 0.22)',
      badgeBorder: '#60a5fa'
    },
    CAUTION: {
      bgTop: '#3b2106',
      bgBottom: '#0f172a',
      accent: '#f59e0b',
      badgeBg: 'rgba(245, 158, 11, 0.22)',
      badgeBorder: '#fbbf24'
    },
    RISK: {
      bgTop: '#3f0d16',
      bgBottom: '#0f172a',
      accent: '#ef4444',
      badgeBg: 'rgba(239, 68, 68, 0.22)',
      badgeBorder: '#f87171'
    }
  });

  /**
   * 첫해 -30% 폭락장 테스트 상태 문구 판정
   * @param {number} shockSurvivalRate 첫해 -30% 폭락 시 생존확률 (%)
   */
  function getCrashStatusPhrase(shockSurvivalRate) {
    var rate = Number(shockSurvivalRate) || 0;
    if (rate >= 75.0) {
      return '첫해 폭락장 테스트 통과';
    }
    if (rate >= 50.0) {
      return '첫해 폭락장 방어 ' + rate.toFixed(1) + '%';
    }
    return '첫해 폭락장 주의 (' + rate.toFixed(1) + '%)';
  }

  /**
   * 쓰레드·인스타 스토리·카카오 공유용 핵심 한 줄 인증 문구 생성
   * 예시: "FIRE 생존확률 87.4% (안정 등급) | 목표 은퇴 45세 · 인출률 3.8% · 첫해 폭락장 테스트 통과"
   */
  function buildShareCaption(snapshot) {
    var baseSim = snapshot.baseSim;
    var activeSim = snapshot.shockEnabled && snapshot.shockSim ? snapshot.shockSim : baseSim;
    var shockRate = snapshot.shockSurvivalRate;
    var params = snapshot.params || baseSim.params;
    var wr = Number(baseSim.initialWithdrawalRate || 0).toFixed(1);
    var crashText = getCrashStatusPhrase(shockRate);

    var coreLine =
      'FIRE 생존확률 ' + activeSim.survivalRate.toFixed(1) + '% (' + activeSim.grade.fullLabel + ') | ' +
      '목표 은퇴 ' + params.retireAge + '세 · 인출률 ' + wr + '% · ' + crashText;

    if (!snapshot.hideAmounts) {
      var netMonthly = Math.max(0, params.monthlyExpense - params.monthlyExtraIncome);
      coreLine +=
        ' · 은퇴자산(P50) ' + Formatters.formatManwon(activeSim.retireMedianReal) +
        ' · 월 순인출 ' + Formatters.formatManwon(netMonthly);
    }

    return coreLine;
  }

  /**
   * 등급 코드에 대응하는 정적 OG 이미지 URL 반환
   */
  function getGradeOgImageUrl(gradeCode, baseUrl) {
    var relPath = GRADE_OG_ASSETS[gradeCode] || GRADE_OG_ASSETS.MODERATE;
    if (!baseUrl) return './' + relPath;
    try {
      return new URL(relPath, baseUrl).href;
    } catch (_e) {
      var cleanBase = String(baseUrl).split('#')[0].replace(/\/?$/, '/');
      return cleanBase + relPath;
    }
  }

  /**
   * 현재 상태 기준 공유용 전체 URL 생성 (자산 숨김 토글 반영)
   */
  function buildShareUrl(snapshot, pageLocationHref) {
    var baseSim = snapshot.baseSim;
    var params = snapshot.params || baseSim.params;
    var hash = StateCodec.encodeHash(params, {
      shockEnabled: Boolean(snapshot.shockEnabled),
      hideAmounts: Boolean(snapshot.hideAmounts),
      initialWithdrawalRate: baseSim ? baseSim.initialWithdrawalRate : 4.0
    });
    var baseClean = String(pageLocationHref || 'https://fire-montecarlo.enjoy-onepage.com/').split('#')[0];
    return baseClean + hash;
  }

  /**
   * Kakao.Share.sendDefault 피드 템플릿 페이로드 생성
   */
  function buildKakaoFeedPayload(snapshot, pageLocationHref) {
    var baseSim = snapshot.baseSim;
    var activeSim = snapshot.shockEnabled && snapshot.shockSim ? snapshot.shockSim : baseSim;
    var params = snapshot.params || baseSim.params;
    var shareUrl = buildShareUrl(snapshot, pageLocationHref);
    var baseDirUrl = String(pageLocationHref || 'https://fire-montecarlo.enjoy-onepage.com/').split('#')[0];
    if (!/\/$/.test(baseDirUrl)) {
      baseDirUrl = baseDirUrl.replace(/[^/]*$/, '');
    }
    var imageUrl = getGradeOgImageUrl(activeSim.grade.code, baseDirUrl);
    var crashText = getCrashStatusPhrase(snapshot.shockSurvivalRate);

    var title = '내 FIRE 은퇴 생존확률 ' + activeSim.survivalRate.toFixed(1) + '% (' + activeSim.grade.fullLabel + ')';
    var description = '목표 은퇴 ' + params.retireAge + '세 · 초기 인출률 ' +
      Number(baseSim.initialWithdrawalRate || 0).toFixed(1) + '% · ' + crashText;

    if (!snapshot.hideAmounts) {
      description += ' | 은퇴 예상 자산 ' + Formatters.formatManwon(activeSim.retireMedianReal);
    }

    return {
      objectType: 'feed',
      content: {
        title: title,
        description: description,
        imageUrl: imageUrl,
        imageWidth: 1200,
        imageHeight: 630,
        link: {
          mobileWebUrl: shareUrl,
          webUrl: shareUrl
        }
      },
      buttons: [
        {
          title: '내 은퇴 생존확률 계산하기',
          link: {
            mobileWebUrl: shareUrl,
            webUrl: shareUrl
          }
        }
      ]
    };
  }

  /**
   * 1080x1920 (9:16 비율) 인스타 스토리·쓰레드용 인증샷 카드를 Canvas에 렌더링
   * @param {HTMLCanvasElement} canvas 대상 캔버스
   * @param {Object} snapshot { params, baseSim, shockSim, shockSurvivalRate, shockP50Real, shockEnabled, hideAmounts, watermarkText }
   */
  function renderStoryCardToCanvas(canvas, snapshot) {
    var W = CanvasCardBase.WIDTH;   // 1080
    var H = CanvasCardBase.HEIGHT;  // 1920
    canvas.width = W;
    canvas.height = H;

    var ctx = canvas.getContext('2d');
    var baseSim = snapshot.baseSim;
    var activeSim = snapshot.shockEnabled && snapshot.shockSim ? snapshot.shockSim : baseSim;
    var params = snapshot.params || baseSim.params;
    var grade = activeSim.grade;
    var theme = CARD_THEMES[grade.code] || CARD_THEMES.MODERATE;
    var hideAmounts = Boolean(snapshot.hideAmounts);
    var shockRate = Number(snapshot.shockSurvivalRate || 0);
    var crashPhrase = getCrashStatusPhrase(shockRate);

    // 1. 배경 그라데이션
    var bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, theme.bgTop);
    bgGrad.addColorStop(0.55, '#0f172a');
    bgGrad.addColorStop(1, theme.bgBottom);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // 상단 컬러 포인트 바
    ctx.fillStyle = theme.accent;
    ctx.fillRect(0, 0, W, 16);

    var fontStack = '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

    // 2. 상단 브랜드 타이틀 & 프라이버시 배지
    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 30px ' + fontStack;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('FIRE MONTE CARLO REPORT', 80, 88);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '800 48px ' + fontStack;
    ctx.fillText('파이어족 은퇴 생존확률 진단', 80, 134);

    // 프라이버시 상태 캡슐 (우측 상단)
    var modePillText = hideAmounts ? '자산 비공개 인증' : '상세 수치 포함';
    CanvasCardBase.drawRoundRect(ctx, W - 310, 86, 230, 52, 26);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.fill();
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '700 24px ' + fontStack;
    ctx.textAlign = 'center';
    ctx.fillText(modePillText, W - 195, 100);

    // 3. 메인 히어로 생존확률 박스 (y: 230 ~ 680)
    CanvasCardBase.drawRoundRect(ctx, 72, 230, W - 144, 440, 36);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.68)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.stroke();

    // 등급 배지 알약
    CanvasCardBase.drawRoundRect(ctx, 120, 276, 220, 62, 31);
    ctx.fillStyle = theme.badgeBg;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = theme.badgeBorder;
    ctx.stroke();

    ctx.fillStyle = theme.badgeBorder;
    ctx.font = '800 30px ' + fontStack;
    ctx.textAlign = 'center';
    ctx.fillText(grade.fullLabel, 230, 292);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 26px ' + fontStack;
    ctx.textAlign = 'right';
    ctx.fillText('2,000회 확률 시뮬레이션', W - 120, 294);

    // 대형 생존확률 숫자
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 156px ' + fontStack;
    ctx.textAlign = 'left';
    ctx.fillText(activeSim.survivalRate.toFixed(1) + '%', 116, 366);

    // 게이지 트랙 & 바
    CanvasCardBase.drawRoundRect(ctx, 120, 556, W - 240, 24, 12);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fill();

    var barW = Math.max(28, Math.round((W - 240) * Math.min(100, Math.max(0, activeSim.survivalRate)) / 100));
    CanvasCardBase.drawRoundRect(ctx, 120, 556, barW, 24, 12);
    ctx.fillStyle = theme.accent;
    ctx.fill();

    // 한 줄 요약 문구 (SPEC 예시 포맷 반영)
    var wrShort = Number(baseSim.initialWithdrawalRate || 0).toFixed(1);
    var summaryBannerText = '목표 은퇴 ' + params.retireAge + '세 · 인출률 ' + wrShort + '% · ' + crashPhrase;
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '700 30px ' + fontStack;
    ctx.textAlign = 'left';
    ctx.fillText(summaryBannerText, 120, 608);

    // 4. 중앙 미니 팬차트 실루엣 카드 (y: 706 ~ 1210)
    CanvasCardBase.drawRoundRect(ctx, 72, 706, W - 144, 504, 36);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.68)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.stroke();

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '700 30px ' + fontStack;
    ctx.textAlign = 'left';
    ctx.fillText('연령별 자산 백분위수 궤적 (P10 ~ P90)', 116, 750);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 24px ' + fontStack;
    ctx.textAlign = 'right';
    ctx.fillText(params.currentAge + '세 → 은퇴 ' + params.retireAge + '세 → ' + params.targetAge + '세', W - 116, 754);

    // 팬차트 실루엣 렌더링 (금액 Y축 숫자를 쓰지 않아 자산 숨김 모드에서도 100% 안전)
    CanvasCardBase.drawMiniFanSilhouette(
      ctx,
      { x: 116, y: 820, w: W - 232, h: 310 },
      baseSim.percentilesReal,
      snapshot.shockP50Real
    );

    // 차트 범례 캡션
    ctx.fillStyle = '#93c5fd';
    ctx.font = '600 23px ' + fontStack;
    ctx.textAlign = 'left';
    ctx.fillText('● 파란 실선: 평시 중앙값(P50)', 116, 1152);
    ctx.fillStyle = '#fda4af';
    ctx.textAlign = 'right';
    ctx.fillText('--- 붉은 점선: 은퇴 첫해 -30% 폭락 시 중앙값', W - 116, 1152);

    // 5. 하단 2x2 핵심 지표 그리드 (y: 1246 ~ 1686)
    var retireSpan = Math.max(1, params.targetAge - params.retireAge);
    var netMonthly = Math.max(0, params.monthlyExpense - params.monthlyExtraIncome);

    var metricBoxes = hideAmounts
      ? [
          { label: '목표 은퇴 연령', value: params.retireAge + '세', sub: '은퇴 유지 기간 ' + retireSpan + '년' },
          { label: '은퇴 첫해 초기 인출률', value: wrShort + '%', sub: '4% 룰 대비 비율 진단' },
          { label: '첫해 -30% 폭락 생존율', value: shockRate.toFixed(1) + '%', sub: crashPhrase },
          { label: '포트폴리오 가정', value: '연 ' + params.expectedReturn.toFixed(1) + '%', sub: '변동성 ' + params.volatility.toFixed(1) + '% · 물가 ' + params.inflation.toFixed(1) + '%' }
        ]
      : [
          { label: '목표 은퇴 연령', value: params.retireAge + '세', sub: '은퇴 유지 기간 ' + retireSpan + '년' },
          { label: '은퇴 첫해 초기 인출률', value: wrShort + '%', sub: crashPhrase },
          { label: '은퇴 시점 예상 자산(P50)', value: Formatters.formatManwon(activeSim.retireMedianReal), sub: '현재가치 환산 중앙값' },
          { label: '은퇴 후 월 순인출액', value: Formatters.formatManwon(netMonthly), sub: '추가 고정수입 차감 후' }
        ];

    var cardGap = 24;
    var boxW = Math.floor((W - 144 - cardGap) / 2);
    var boxH = 204;

    metricBoxes.forEach(function (item, idx) {
      var col = idx % 2;
      var row = Math.floor(idx / 2);
      var bx = 72 + col * (boxW + cardGap);
      var by = 1246 + row * (boxH + cardGap);

      CanvasCardBase.drawRoundRect(ctx, bx, by, boxW, boxH, 28);
      ctx.fillStyle = 'rgba(30, 41, 59, 0.72)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.20)';
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 25px ' + fontStack;
      ctx.textAlign = 'left';
      ctx.fillText(item.label, bx + 36, by + 34);

      ctx.fillStyle = '#ffffff';
      ctx.font = '800 46px ' + fontStack;
      ctx.fillText(item.value, bx + 36, by + 84);

      ctx.fillStyle = '#cbd5e1';
      ctx.font = '500 22px ' + fontStack;
      ctx.fillText(item.sub, bx + 36, by + 150);
    });

    // 6. 푸터 워터마크 영역
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 26px ' + fontStack;
    ctx.textAlign = 'center';
    var watermark = snapshot.watermarkText || 'fire-montecarlo.enjoy-onepage.com/';
    ctx.fillText(watermark, W / 2, 1775);

    ctx.fillStyle = '#64748b';
    ctx.font = '500 21px ' + fontStack;
    ctx.fillText('박스-뮬러 정규분포 몬테카를로 시뮬레이션 · 내 은퇴 생존확률 무료 테스트', W / 2, 1820);

    return {
      width: W,
      height: H,
      caption: buildShareCaption(snapshot),
      hideAmounts: hideAmounts
    };
  }

  /**
   * 브라우저 DOM 바인딩 (index.html #viralShareSlot 자동 마운트)
   */
  function initBrowserViralWidget() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    var slot = document.getElementById('viralShareSlot');
    if (!slot) return;

    var previewCanvas = document.getElementById('storyCardPreviewCanvas');
    var hideCardToggle = document.getElementById('toggleCardHideAmounts');
    var captionPreviewEl = document.getElementById('viralCaptionPreview');
    var btnDownloadCard = document.getElementById('btnDownloadStoryPng');
    var btnShareNative = document.getElementById('btnWebShareStory');
    var btnCopyCaption = document.getElementById('btnCopyStoryCaption');
    var btnKakaoShare = document.getElementById('btnKakaoShare');
    var statusMsgEl = document.getElementById('viralStatusFeedback');

    if (!previewCanvas) return;

    var cardHideAmounts = true;
    var latestSnapshot = null;
    var feedbackTimer = null;

    function showFeedback(text, isWarn) {
      if (!statusMsgEl) return;
      statusMsgEl.textContent = text;
      statusMsgEl.style.color = isWarn ? '#d97706' : '#059669';
      statusMsgEl.classList.add('is-visible');
      if (feedbackTimer) clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(function () {
        statusMsgEl.classList.remove('is-visible');
      }, 3200);
    }

    function copyTextSafe(text) {
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
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    }

    function computeSnapshotFromAppState(appState) {
      if (!appState || !appState.baseSim) return null;
      var shockSimRef = appState.shockSim || Engine.runSimulation(appState.params, {
        iterations: 2000,
        firstYearShock: -0.30,
        seed: 20261125
      });

      return {
        params: appState.params,
        baseSim: appState.baseSim,
        shockSim: appState.shockSim,
        shockSurvivalRate: shockSimRef.survivalRate,
        shockP50Real: shockSimRef.percentilesReal.p50,
        shockEnabled: Boolean(appState.shockEnabled),
        hideAmounts: cardHideAmounts
      };
    }

    function refreshCardAndCaption(appState) {
      latestSnapshot = computeSnapshotFromAppState(appState);
      if (!latestSnapshot) return;
      var rendered = renderStoryCardToCanvas(previewCanvas, latestSnapshot);
      if (captionPreviewEl) {
        captionPreviewEl.textContent = rendered.caption;
      }
    }

    // 자산 총액 숨김 토글 (메인 공유 체크박스와도 연동)
    var mainHideCheck = document.getElementById('toggleHideAmountsShare');
    if (hideCardToggle) {
      cardHideAmounts = Boolean(hideCardToggle.checked);
      hideCardToggle.addEventListener('change', function () {
        cardHideAmounts = Boolean(hideCardToggle.checked);
        if (mainHideCheck) {
          mainHideCheck.checked = cardHideAmounts;
          mainHideCheck.dispatchEvent(new Event('change'));
        }
        if (window.FireMainApp) {
          refreshCardAndCaption(window.FireMainApp.getLatestState());
        }
      });
    }

    // 1. 9:16 PNG 저장 버튼
    if (btnDownloadCard) {
      btnDownloadCard.addEventListener('click', function () {
        if (!latestSnapshot) return;
        renderStoryCardToCanvas(previewCanvas, latestSnapshot);
        var activeSim = latestSnapshot.shockEnabled && latestSnapshot.shockSim
          ? latestSnapshot.shockSim
          : latestSnapshot.baseSim;
        var fname = 'fire-survival-' + activeSim.grade.code.toLowerCase() + '-' + latestSnapshot.params.retireAge + 'y.png';
        CanvasCardBase.downloadPng(previewCanvas, fname).then(function () {
          showFeedback('9:16 고해상도(1080×1920) 인증샷 PNG가 저장되었습니다.');
        }).catch(function () {
          showFeedback('이미지 저장 중 오류가 발생했습니다.', true);
        });
      });
    }

    // 2. 모바일 Web Share API (인스타 스토리·쓰레드 공유)
    if (btnShareNative) {
      btnShareNative.addEventListener('click', function () {
        if (!latestSnapshot) return;
        renderStoryCardToCanvas(previewCanvas, latestSnapshot);
        var caption = buildShareCaption(latestSnapshot);
        var shareUrl = buildShareUrl(latestSnapshot, window.location.href);

        CanvasCardBase.toBlobPromise(previewCanvas).then(function (blob) {
          var file = typeof File === 'function'
            ? new File([blob], 'fire-survival-card.png', { type: 'image/png' })
            : null;

          if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
            return navigator.share({
              title: '내 FIRE 은퇴 생존확률 진단',
              text: caption,
              url: shareUrl,
              files: [file]
            }).then(function () {
              showFeedback('공유 시트를 열었습니다.');
            });
          }

          // 데스크톱 폴백: PNG 다운로드 + 문구 클립보드 자동 복사
          return CanvasCardBase.downloadPng(previewCanvas, 'fire-survival-card.png').then(function () {
            return copyTextSafe(caption + '\n' + shareUrl);
          }).then(function () {
            showFeedback('PNG 저장 및 인스타·쓰레드용 문구가 클립보드에 복사되었습니다!');
          });
        }).catch(function (err) {
          if (err && err.name === 'AbortError') return;
          showFeedback('공유 처리 중 취소되었거나 폴백 복사로 전환되었습니다.', true);
        });
      });
    }

    // 3. 인증 문구 + 압축 링크 복사 버튼
    if (btnCopyCaption) {
      btnCopyCaption.addEventListener('click', function () {
        if (!latestSnapshot) return;
        var caption = buildShareCaption(latestSnapshot);
        var shareUrl = buildShareUrl(latestSnapshot, window.location.href);
        copyTextSafe(caption + '\n' + shareUrl).then(function () {
          showFeedback('인증 문구와 결과 링크가 복사되었습니다! 쓰레드·SNS에 바로 붙여넣으세요.');
        });
      });
    }

    // 4. 카카오톡 공유 SDK (Kakao.Share.sendDefault) 연동
    if (btnKakaoShare) {
      btnKakaoShare.addEventListener('click', function () {
        if (!latestSnapshot) return;
        var payload = buildKakaoFeedPayload(latestSnapshot, window.location.href);
        var metaKeyEl = document.querySelector('meta[name="kakao-js-key"]');
        var appKey = (window.FIRE_KAKAO_JS_KEY || (metaKeyEl && metaKeyEl.getAttribute('content')) || '').trim();

        function fallbackKakaoShare() {
          var shareUrl = payload.content.link.webUrl;
          var textMsg = payload.content.title + '\n' + payload.content.description;
          if (navigator.share) {
            navigator.share({
              title: payload.content.title,
              text: payload.content.description,
              url: shareUrl
            }).catch(function () {});
            return;
          }
          copyTextSafe(textMsg + '\n' + shareUrl).then(function () {
            showFeedback('카카오톡 공유용 요약 문구와 링크가 복사되었습니다! 대화창에 붙여넣어 공유하세요.');
          });
        }

        if (!appKey) {
          fallbackKakaoShare();
          return;
        }

        UICore.loadScriptOnce(UICore.CDN_URLS.kakaoSdk, function () {
          return typeof window.Kakao !== 'undefined';
        }).then(function () {
          if (!window.Kakao.isInitialized()) {
            window.Kakao.init(appKey);
          }
          window.Kakao.Share.sendDefault(payload);
          showFeedback('카카오톡 공유 창을 열었습니다.');
        }).catch(function () {
          fallbackKakaoShare();
        });
      });
    }

    // 시뮬레이션 갱신 이벤트 구독 및 최초 1회 렌더링
    window.addEventListener('fire:simulation-updated', function (ev) {
      refreshCardAndCaption(ev.detail);
    });

    if (window.FireMainApp) {
      refreshCardAndCaption(window.FireMainApp.getLatestState());
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initBrowserViralWidget);
    } else {
      initBrowserViralWidget();
    }
  }

  return {
    GRADE_OG_ASSETS: GRADE_OG_ASSETS,
    getCrashStatusPhrase: getCrashStatusPhrase,
    buildShareCaption: buildShareCaption,
    getGradeOgImageUrl: getGradeOgImageUrl,
    buildShareUrl: buildShareUrl,
    buildKakaoFeedPayload: buildKakaoFeedPayload,
    renderStoryCardToCanvas: renderStoryCardToCanvas
  };
});
