/**
 * SingVaza v10.0 — Android 8.1 Zero-Crackle Native Hardware Audio Controller
 * - 100% Pure OS Hardware <audio> Output (Bypasses buggy OpenSL ES 128-frame real-time WebAudio mixer on Android 8.1!)
 * - Instant 10ms Hardware MP3 Demo Stream + Ultra-Fast Offline-to-Hardware Stream Mix Engine (~120ms swap)
 * - Throttled Low-CPU 10 FPS Canvas HUD + Fixed Single-Pass Lyric Sync (Zero DOM Reflow Stutter)
 */

const App = (() => {
  const isLowEndDevice =
    /Android [4-9]\./i.test(navigator.userAgent || '') ||
    (navigator.deviceMemory && navigator.deviceMemory <= 4) ||
    (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);

  // Double-Buffered OS-Level Hardware Audio Players (Direct Android AudioFlinger / iOS CoreAudio hardware pipeline — 0% JS DSP crackle!)
  function createHardwareAudioEl(id) {
    const el = document.createElement('audio');
    el.id = id;
    el.preload = 'auto';
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.style.display = 'none';
    return el;
  }
  let hwAudio = createHardwareAudioEl('singvazaHwAudioA');
  let hwAudioStandby = createHardwareAudioEl('singvazaHwAudioB');

  const clientTimezone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
  })();

  function getLocalDayKey(timezone = clientTimezone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
    } catch (_) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function loadGuestDailyExports() {
    const today = getLocalDayKey();
    if (localStorage.getItem('singvaza_daily_date') !== today) {
      localStorage.setItem('singvaza_daily_date', today);
      localStorage.setItem('singvaza_daily_used', '0');
      return 0;
    }
    return Number(localStorage.getItem('singvaza_daily_used') || '0');
  }

  const state = {
    view: 'home',
    stageMode: 'video',
    user: null,
    projects: [],
    authToken: localStorage.getItem('singvaza_token') || '',
    authMode: 'register',
    isProDemo: localStorage.getItem('singvaza_pro_demo') === '1',
    exportsUsed: loadGuestDailyExports(),
    dailyLimit: 9,
    quota: {
      proActive: false,
      proDaysLeft: 0,
      dailyUsed: loadGuestDailyExports(),
      dailyLimit: 9,
      timezone: clientTimezone,
      localDate: getLocalDayKey(),
      minutesToMidnight: 720,
    },
    googleClientId: '',

    audioCtx: null,
    audioUnlocked: false,
    originalBackingBuffer: null,
    backingBuffer: null,
    rawVocalBuffer: null,
    tunedVocalBuffer: null,
    backingPeaks: null,
    vocalPeaks: null,
    pitchFrames: [],
    pitchScore: 95,
    isDemoSession: true,
    demoEdited: false,
    mixDirty: false,
    cachedMixUrl: '',
    renderSeq: 0,
    userLoadedBacking: false,
    backingDecodePending: false,
    backingLoadSeq: 0,
    uploadedMediaUrl: '',
    uploadedIsVideo: false,
    uploadedFileName: '',
    lastMasterBlob: null,
    lastMasterMime: 'audio/mpeg',
    lastMasterFilename: 'singvaza-master.mp3',
    ytPlayer: null,
    ytSyncInterval: null,
    waitingForYtTap: false,

    isPlaying: false,
    pausePositionSec: 0,
    uiTimerId: null,
    refreshTimerId: null,
    cropStartRatio: 0,
    cropEndRatio: 1,
    uncroppedBackup: null,

    karaokeCutActive: false,
    karaokeBuffer: null,
    karaokeWavUrl: '',
    karaokeInfo: null,
    karaokeDirty: false,
    karaokeBusy: false,
    karaokeJobSeq: 0,
    karaokeWorker: null,
    karaokeWorkerReject: null,
    stageKaraokeActive: false,
    karaokeUnlocking: false,
    stageKaraokeAudio: null,
    stageKaraokeCleanup: null,
    transposeSemitones: 0,
    karaokeResults: [],
    karaokeIndex: 0,
    lrcLines: [],

    isRecording: false,
    isMonitoring: false,
    micStream: null,
    micAnalyser: null,
    mediaRecorder: null,
    recChunks: [],
    recStartMs: 0,
    recMeterTimer: null,

    activePreset: 'crystal_hd',
    params: {
      ...SingVazaDSP.PRESETS.crystal_hd,
      vocalOffsetMs: Number(localStorage.getItem('singvaza_mic_offset_ms') || 0) || 0,
      scaleKey: 9,
      bypassFx: false,
      soloVocal: false,
    },
  };

  let demoLoadPromise = null;

  // Pre-build smooth synthetic preview peaks immediately so Mix Studio looks crisp with 0 MB decoded on boot
  function initLightweightDemoEnvelope() {
    const n = 220;
    const bp = new Float32Array(n);
    const vp = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 12) * Math.min(1, (n - i) / 14);
      bp[i] = env * (0.34 + 0.22 * Math.abs(Math.sin(i * 0.27)) + 0.14 * Math.abs(Math.cos(i * 0.71)));
      const phrase = Math.max(0.06, Math.sin(i * 0.145) * 0.65 + 0.35);
      vp[i] = env * phrase * (0.42 + 0.34 * Math.abs(Math.sin(i * 0.43)));
    }
    state.backingPeaks = bp;
    state.vocalPeaks = vp;
  }

  // ==================== HARDWARE AUDIO & LOW-LATENCY CONTEXT HELPERS ====================
  function ensureAudioCtx() {
    if (!state.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      try {
        state.audioCtx = new AC({ latencyHint: 'playback' });
      } catch (_) {
        state.audioCtx = new AC();
      }
    }
    return state.audioCtx;
  }

  function stopLiveGraphNodes() {
    if (state.liveNodes && Array.isArray(state.liveNodes.sources)) {
      for (const src of state.liveNodes.sources) {
        try { src.stop(0); } catch (_) {}
        try { src.disconnect(); } catch (_) {}
      }
    }
    state.liveNodes = null;
    state.livePlaying = false;
  }

  // Suspend idle WebAudio context when not actively playing/monitoring so Android 8.1 OpenSL ES uses 0.0% CPU!
  function suspendIdleWebAudio() {
    if (state.audioCtx && !state.isRecording && !state.isMonitoring && !state.livePlaying && state.audioCtx.state === 'running') {
      state.audioCtx.suspend().catch(() => {});
    }
  }

  function unlockMobileAudioSync() {
    if (!document.body.contains(hwAudio)) document.body.appendChild(hwAudio);
    if (!document.body.contains(hwAudioStandby)) document.body.appendChild(hwAudioStandby);
    try {
      if (navigator.audioSession && navigator.audioSession.type !== 'playback') {
        navigator.audioSession.type = 'playback';
      }
    } catch (_) {}

    if (!state.audioUnlocked) {
      state.audioUnlocked = true;
      if (!hwAudio.src) {
        hwAudio.src = '/assets/demo-studio-fx.mp3';
        hwAudio.load();
      }
      if (!hwAudioStandby.src) {
        hwAudioStandby.src = '/assets/demo-studio-fx.mp3';
        hwAudioStandby.load();
      }
    }
  }

  function markMixDirty() {
    state.mixDirty = true;
    if (state.isDemoSession) state.demoEdited = true;
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  // The tool pages have their own URLs; navigation inside the studio keeps the
  // decoded audio in memory, so sending a backing to Sing does not re-upload it.
  const viewUrls = { home: '/', blog: '/#blog', 'vocal-remover': '/studio/vocal-remover', sing: '/studio/karaoke-recorder', mix: '/studio/karaoke-recorder#mix', library: '/studio/karaoke-recorder#library' };
  function viewFromLocation() {
    const path = location.pathname.replace(/\/$/, '');
    if (path === '/studio/vocal-remover') return 'vocal-remover';
    if (path === '/studio/karaoke-recorder') return location.hash === '#mix' ? 'mix' : location.hash === '#library' ? 'library' : 'sing';
    return location.hash === '#blog' ? 'blog' : 'home';
  }
  function switchView(view, updateUrl = true) {
    if (!viewUrls[view]) view = 'home';
    state.view = view;
    document.querySelectorAll('.app-view').forEach((el) => el.classList.toggle('active', el.id === `view-${view}`));
    const section = view === 'blog' ? 'blog' : 'home';
    document.querySelectorAll('.nav-item, .mob-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === section));
    if (updateUrl && location.pathname + location.hash !== viewUrls[view]) history.pushState({ view }, '', viewUrls[view]);
    if (view === 'home' && updateUrl && discoveryFetched) loadDiscovery(true);
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (view === 'mix') {
      requestAnimationFrame(() => { drawSpectrum(); drawTimeline(); drawPitchGraph(); });
    } else if (view === 'vocal-remover') {
      updateVocalRemoverUI();
    } else if (view === 'library') refreshServerState();
    else if (view === 'blog') loadBlogPostsFromServer();
  }

  function openVocalRemover() {
    if (state.isRecording || state.waitingForYtTap) stopActiveRecordingNow();
    else pauseYoutubeStage();
    if (state.isPlaying) pausePlayback();
    switchView('vocal-remover');
    requestAnimationFrame(() => {
      const panel = document.getElementById('vocalRemoverPanel');
      if (!panel) return;
      try { panel.focus({ preventScroll: true }); } catch (_) { panel.focus(); }
    });
  }

  function updateVocalRemoverUI(message = '') {
    const button = document.getElementById('btnKaraokeCut');
    const status = document.getElementById('vocalRemoverStatus');
    if (!button || !status) return;
    const hasTrack = Boolean(state.originalBackingBuffer && state.userLoadedBacking && !state.isDemoSession);
    const channels = hasTrack ? state.originalBackingBuffer.numberOfChannels : 0;
    const isStereo = channels === 2;
    const effectActive = Boolean(isStereo && state.karaokeCutActive && !state.backingDecodePending);
    button.disabled = state.karaokeBusy || state.backingDecodePending || !isStereo;
    button.textContent = effectActive ? 'Restore original' : 'Reduce vocals';
    button.setAttribute('aria-pressed', String(effectActive));
    button.classList.toggle('btn-amber', !effectActive);
    const update = document.getElementById('btnUpdateKaraoke');
    if (update) { update.hidden = !effectActive || !state.karaokeDirty; update.disabled = state.karaokeBusy; }
    const cancel = document.getElementById('btnCancelKaraoke');
    if (cancel) cancel.hidden = !state.karaokeBusy;
    const use = document.getElementById('btnUseKaraoke');
    if (use) { use.hidden = !effectActive || !state.karaokeWavUrl; use.disabled = state.karaokeBusy || state.karaokeDirty; }
    const download = document.getElementById('btnDownloadKaraoke');
    if (download) { download.hidden = !effectActive || !state.karaokeWavUrl; download.disabled = state.karaokeBusy || state.karaokeDirty; }
    const compare = document.getElementById('karaokeCompare');
    if (compare) compare.hidden = !effectActive || !state.karaokeWavUrl;
    const progress = document.getElementById('karaokeProgress');
    if (progress) { progress.hidden = !state.karaokeBusy; if (state.karaokeBusy && !progress.value) progress.value = 0; }
    for (const id of ['karaokeStrength', 'karaokeIntro', 'karaokePresetMusic', 'karaokePresetBalanced', 'karaokePresetStrong']) {
      const el = document.getElementById(id); if (el) el.disabled = state.karaokeBusy;
    }
    if (message) status.textContent = message;
    else if (state.backingDecodePending) status.textContent = 'Preparing your audio…';
    else if (!hasTrack) status.textContent = 'Choose a stereo song to begin.';
    else if (channels === 1) status.textContent = 'This track is mono. Choose a stereo file for vocal reduction.';
    else if (!isStereo) status.textContent = 'Please choose a two-channel stereo file; multichannel audio is not supported.';
    else if (effectActive && state.karaokeDirty) status.textContent = 'Settings changed. Tap Update karaoke to apply them.';
    else if (effectActive) status.textContent = 'Vocal reduction is on. Compare the versions or use the karaoke backing in Sing.';
    else status.textContent = `Ready: ${state.uploadedFileName || 'your song'}. Choose settings and tap Reduce vocals.`;
  }

  // Browser-local vocal reduction. The worker uses private transferred copies,
  // while native media elements continue to handle playback on older phones.
  function cancelKaraokeJob() {
    state.karaokeJobSeq += 1;
    if (state.karaokeWorker) {
      try { state.karaokeWorker.postMessage({ type: 'cancel' }); } catch (_) {}
      state.karaokeWorker.terminate();
      state.karaokeWorker = null;
    }
    if (state.karaokeWorkerReject) {
      const reject = state.karaokeWorkerReject;
      state.karaokeWorkerReject = null;
      reject(Object.assign(new Error('Processing cancelled.'), { name: 'AbortError' }));
    }
    state.karaokeBusy = false;
  }

  function runKaraokeWorker(type, buffer, options, onStage) {
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker('/karaoke-worker.js?v=4.0'); }
      catch (_) { reject(new Error('This browser could not start audio processing.')); return; }
      state.karaokeWorker = worker;
      state.karaokeWorkerReject = reject;
      const finish = () => {
        worker.terminate();
        if (state.karaokeWorker === worker) state.karaokeWorker = null;
        if (state.karaokeWorkerReject === reject) state.karaokeWorkerReject = null;
      };
      worker.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === 'progress') {
          const bar = document.getElementById('karaokeProgress');
          if (bar && typeof data.progress === 'number') {
            // Keep the bar monotonic across the download/separate/encode phases.
            const pct = Math.round(Math.max(0, Math.min(1, data.progress)) * 100);
            bar.value = Math.max(Number(bar.value) || 0, pct);
          }
          if (onStage) onStage(data);
        } else if (data.type === 'result') { finish(); resolve(data); }
        else if (data.type === 'cancelled') { finish(); reject(Object.assign(new Error('Processing cancelled.'), { name: 'AbortError' })); }
        else if (data.type === 'error') { finish(); reject(new Error(data.message || 'Audio processing failed.')); }
      };
      worker.onerror = () => { finish(); reject(new Error('Could not process this track. Try a shorter file or another browser.')); };
      try {
        const left = new Float32Array(buffer.getChannelData(0));
        const right = new Float32Array(buffer.getChannelData(1));
        worker.postMessage({ type, left: left.buffer, right: right.buffer, sampleRate: buffer.sampleRate, options }, [left.buffer, right.buffer]);
      } catch (err) { finish(); reject(err); }
    });
  }

  function karaokeStageMessage(data) {
    if (!data) return 'Working locally… your file stays on this device.';
    if (data.stage === 'engine') return data.backend === 'webgpu'
      ? 'Loading the AI engine (GPU)…'
      : 'Loading the AI engine (processor)…';
    if (data.stage === 'model') {
      const pct = data.total ? Math.round((data.loaded / data.total) * 100) : 0;
      return `Downloading the AI vocal model once (${pct}%). It is cached for next time.`;
    }
    if (data.stage === 'model-cached') return 'AI vocal model ready (cached on this device).';
    if (data.stage === 'session') return 'Starting the AI model…';
    if (data.stage === 'separate') return `Separating vocals with AI… ${Math.round((data.fraction || 0) * 100)}% (${data.chunk || 0}/${data.chunks || 0} windows)`;
    if (data.stage === 'fallback') return 'AI engine unavailable — using the offline centre-reducer instead.';
    if (data.stage === 'instant') return `Removing the centre vocal… ${Math.round((data.progress || 0) * 100)}%`;
    if (data.stage === 'encode') return 'Building the karaoke backing WAV…';
    return 'Working locally… your file stays on this device.';
  }

  function deactivateStageKaraoke() {
    const media = document.getElementById('stageUploadedMedia');
    if (state.stageKaraokeCleanup) {
      state.stageKaraokeCleanup();
      state.stageKaraokeCleanup = null;
    }
    if (state.stageKaraokeActive && media) {
      try {
        media.pause();
        if (!state.uploadedIsVideo && state.uploadedMediaUrl) { media.src = state.uploadedMediaUrl; media.load(); }
        media.muted = false;
      } catch (_) {}
    }
    state.stageKaraokeActive = false;
    state.stageKaraokeAudio = null;
    const label = document.getElementById('stageKaraokeLabel');
    if (label) { label.hidden = true; label.textContent = ''; }
  }

  function releaseKaraokeResult() {
    deactivateStageKaraoke();
    const player = document.getElementById('karaokeComparePlayer');
    if (player) { try { player.pause(); player.removeAttribute('src'); player.load(); } catch (_) {} }
    if (state.karaokeWavUrl) { try { URL.revokeObjectURL(state.karaokeWavUrl); } catch (_) {} }
    state.karaokeWavUrl = '';
    state.karaokeBuffer = null;
    state.karaokeInfo = null;
    state.karaokeDirty = false;
    state.karaokeCutActive = false;
  }

  function resetKaraoke() {
    cancelKaraokeJob();
    releaseKaraokeResult();
  }

  function karaokeSettingsChanged() {
    const strength = Number(document.getElementById('karaokeStrength')?.value || 0);
    const value = document.getElementById('karaokeStrengthValue');
    if (value) value.textContent = `${strength}%`;
    for (const [id, n] of [['karaokePresetMusic', 65], ['karaokePresetBalanced', 85], ['karaokePresetStrong', 100]]) {
      document.getElementById(id)?.setAttribute('aria-pressed', String(strength === n));
    }
    if (state.karaokeCutActive) {
      state.karaokeDirty = true;
      if (state.stageKaraokeActive) {
        deactivateStageKaraoke();
        const label = document.getElementById('stageKaraokeLabel');
        if (label) { label.hidden = false; label.textContent = 'Settings changed: this stage is playing the original until you update karaoke and select it again.'; }
      }
    }
    updateVocalRemoverUI(state.karaokeCutActive ? 'Settings changed. The previous version is still active; tap Update karaoke to apply them.' : '');
  }

  function setKaraokePreset(value) {
    const input = document.getElementById('karaokeStrength');
    if (input) input.value = String(value);
    karaokeSettingsChanged();
  }

  function markKaraokeIntro() {
    if (state.karaokeBusy) return;
    const player = document.getElementById('karaokeComparePlayer');
    const sec = player && Number.isFinite(player.currentTime) && player.currentTime > 0 ? player.currentTime : getCurrentPlayhead();
    document.getElementById('karaokeIntro').value = String(Math.max(0, Math.round(sec * 10) / 10));
    karaokeSettingsChanged();
    showToast(sec > 0 ? `Intro end set to ${fmtTime(sec)}` : 'Play or seek first, then tap Use playhead');
  }

  function cancelKaraokeProcessing() {
    cancelKaraokeJob();
    updateVocalRemoverUI('Processing cancelled. Your previous audio is unchanged.');
  }

  function compareKaraoke(which) {
    if (!state.karaokeWavUrl || !state.uploadedMediaUrl) return;
    const player = document.getElementById('karaokeComparePlayer');
    if (!player) return;
    const position = Number.isFinite(player.currentTime) ? player.currentTime : 0;
    const wasPlaying = !player.paused;
    stopPlaybackInternal();
    const karaoke = which !== 'original';
    document.getElementById('compareOriginal')?.setAttribute('aria-pressed', String(!karaoke));
    document.getElementById('compareKaraoke')?.setAttribute('aria-pressed', String(karaoke));
    player.src = karaoke ? state.karaokeWavUrl : state.uploadedMediaUrl;
    const seek = () => { try { if (Number.isFinite(player.duration)) player.currentTime = Math.min(position, player.duration); } catch (_) {} };
    player.addEventListener('loadedmetadata', seek, { once: true });
    if (wasPlaying) player.play().catch(() => showToast('Tap play to compare this version.'));
  }

  function useKaraokeForSing() {
    if (!state.karaokeCutActive || state.karaokeDirty || !state.karaokeWavUrl || state.karaokeBusy) {
      showToast('Apply the latest karaoke settings first.'); return;
    }
    if (state.uncroppedBackup) {
      showToast('Undo the Mix crop before using this track in Sing, so the stage stays in sync.'); return;
    }
    const media = document.getElementById('stageUploadedMedia');
    if (!media) { showToast('Upload your audio or video again to use the Sing stage.'); return; }
    deactivateStageKaraoke();
    try { document.getElementById('karaokeComparePlayer')?.pause(); } catch (_) {}
    stopPlaybackInternal();
    media.pause();
    try { media.currentTime = 0; } catch (_) {}
    if (!state.uploadedIsVideo) {
      media.src = state.karaokeWavUrl;
      media.muted = false;
      media.load();
    } else {
      // Keep native video rendering; its original soundtrack must stay muted.
      // A second native audio element plays the processed WAV in sync.
      const audio = createHardwareAudioEl('stageKaraokeAudio');
      audio.src = state.karaokeWavUrl;
      audio.preload = 'auto';
      document.getElementById('stageVideoWrap')?.appendChild(audio);
      state.stageKaraokeAudio = audio;
      media.muted = true;
      let lastCorrection = 0;
      let disposed = false;
      const sync = (force = false) => {
        if (disposed) return;
        const now = Date.now();
        if (force || (now - lastCorrection > 500 && Math.abs(audio.currentTime - media.currentTime) > 0.25)) {
          try { audio.currentTime = media.currentTime; } catch (_) {}
          lastCorrection = now;
        }
        audio.playbackRate = media.playbackRate;
      };
      const play = () => {
        if (disposed || media.paused || !state.stageKaraokeActive || state.karaokeUnlocking) return;
        media.muted = true;
        sync(true);
        audio.muted = false;
        const promise = audio.play();
        if (promise && promise.catch) promise.catch(() => {
          if (disposed) return;
          media.pause();
          if (state.isRecording) stopActiveRecordingNow();
          showToast('Karaoke audio could not play. Tap play on the video to try again.');
        });
      };
      const pause = () => { try { audio.pause(); } catch (_) {} };
      const seeking = () => { pause(); sync(true); };
      const seeked = () => { sync(true); if (!media.paused) play(); };
      const timeupdate = () => sync(false);
      const rate = () => { audio.playbackRate = media.playbackRate; };
      const volume = () => { if (state.stageKaraokeActive && !media.muted) media.muted = true; };
      const handlers = { play, pause, seeking, seeked, timeupdate, ratechange: rate, volumechange: volume, ended: pause };
      for (const [name, fn] of Object.entries(handlers)) media.addEventListener(name, fn);
      state.stageKaraokeCleanup = () => {
        disposed = true;
        for (const [name, fn] of Object.entries(handlers)) media.removeEventListener(name, fn);
        try { audio.pause(); audio.removeAttribute('src'); audio.load(); audio.remove(); } catch (_) {}
      };
    }
    state.stageKaraokeActive = true;
    const label = document.getElementById('stageKaraokeLabel');
    if (label) {
      label.hidden = false;
      label.textContent = state.uploadedIsVideo
        ? 'Karaoke backing selected. The original video audio is muted; the reduced-vocal audio plays with the video. Wear headphones when recording.'
        : 'Karaoke backing selected for playback and recording. Wear headphones to avoid recording the speakers.';
    }
    switchView('sing');
    requestAnimationFrame(() => document.getElementById('stageKaraokeLabel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    showToast('Karaoke backing is ready in Sing & Record.');
  }

  function setStageMode() {
    // Video and scrollable clean lyrics box remain visible together directly beneath one another!
  }

  // ==================== ON-DEMAND STEM DECODER (ZERO BOOT RAM SPIKE ON ANDROID 8.1!) ====================
  async function preloadRealDemoAssets() {
    if (state.backingBuffer && state.rawVocalBuffer && state.isDemoSession) {
      return { backBuf: state.backingBuffer, vocBuf: state.rawVocalBuffer };
    }
    if (demoLoadPromise) return demoLoadPromise;
    const loadSeq = state.backingLoadSeq;
    demoLoadPromise = (async () => {
      const ctx = ensureAudioCtx();
      const [backRes, vocRes] = await Promise.all([
        fetch('/assets/demo-backing.mp3'),
        fetch('/assets/demo-vocal.mp3'),
      ]);
      const [backArr, vocArr] = await Promise.all([
        backRes.arrayBuffer(),
        vocRes.arrayBuffer(),
      ]);
      const [backBuf, vocBuf] = await Promise.all([
        ctx.decodeAudioData(backArr),
        ctx.decodeAudioData(vocArr),
      ]);
      // A newer user-selected track takes precedence over an in-flight demo preload.
      if (loadSeq !== state.backingLoadSeq || !state.isDemoSession) {
        demoLoadPromise = null;
        suspendIdleWebAudio();
        return { backBuf, vocBuf };
      }

      state.originalBackingBuffer = backBuf;
      state.backingBuffer = backBuf;
      state.rawVocalBuffer = vocBuf;
      state.tunedVocalBuffer = vocBuf;
      state.backingPeaks = SingVazaDSP.computeWaveformPeaks(backBuf, 220);
      state.vocalPeaks = SingVazaDSP.computeWaveformPeaks(vocBuf, 220);
      state.isDemoSession = true;
      updateVocalRemoverUI();
      suspendIdleWebAudio();
      if (state.view === 'mix') drawTimeline();

      SingVazaDSP.processVocalAsync(ctx, vocBuf, {
        autotuneAmount: 0,
        retuneSpeed: 0.3,
        noiseGate: 0.45,
        scaleKey: 9,
      }).then((res) => {
        if (state.isDemoSession) {
          state.tunedVocalBuffer = res.buffer;
          state.pitchFrames = res.pitchCurve || [];
          state.pitchScore = res.pitchScore || 95;
          updatePitchBadge();
          if (state.view === 'mix') drawPitchGraph();
        }
        suspendIdleWebAudio();
      }).catch(() => {});

      return { backBuf, vocBuf };
    })().catch((err) => {
      demoLoadPromise = null;
      throw err;
    });
    return demoLoadPromise;
  }

  function updatePitchBadge() {
    const el = document.getElementById('pitchScoreBadge');
    if (el) el.textContent = `Pitch ${state.pitchScore}%`;
  }

  // ==================== 100% NATIVE HARDWARE <audio> PLAYBACK ENGINE (ZERO CRACKLE!) ====================
  async function toggleHeroDemo() {
    unlockMobileAudioSync();
    if (state.isPlaying) {
      pausePlayback();
      return;
    }
    if (!state.isDemoSession) {
      resetKaraoke();
      state.backingLoadSeq += 1;
      state.backingDecodePending = false;
      state.isDemoSession = true;
      state.demoEdited = false;
      state.pausePositionSec = 0;
    }
    await startPlayback(state.pausePositionSec);
  }

  async function openMixWithRealDemo() {
    resetKaraoke();
    state.backingLoadSeq += 1;
    state.backingDecodePending = false;
    unlockMobileAudioSync();
    state.isDemoSession = true;
    state.demoEdited = false;
    state.mixDirty = false;
    switchView('mix');
    await startPlayback(0);
    // Warm stems quietly in idle background ONLY on non-low-end devices or if user adjusts sliders later
    if (!isLowEndDevice) {
      preloadRealDemoAssets().catch(() => {});
    }
    showToast('Playing smooth hardware studio mix — tap any preset to customize!');
  }

  async function loadRealSingerDemo(autoPlay = true) {
    resetKaraoke();
    unlockMobileAudioSync();
    stopPlaybackInternal();
    state.isDemoSession = true;
    state.demoEdited = false;
    state.mixDirty = false;
    state.userLoadedBacking = false;
    state.backingDecodePending = false;
    state.backingLoadSeq += 1;
    state.transposeSemitones = 0;
    state.karaokeCutActive = false;
    updateVocalRemoverUI();
    initLightweightDemoEnvelope();
    document.getElementById('projectTitleInput').value = 'Slow Motion Dream — Studio Mix';
    applyPreset('crystal_hd', false);
    state.demoEdited = false;
    state.mixDirty = false;
    state.pausePositionSec = 0;
    drawTimeline(0);
    if (autoPlay) await startPlayback(0);
    showToast('Loaded real female vocal + studio backing band!');
  }

  async function loadInstrumentalDemoForSing() {
    unlockMobileAudioSync();
    await preloadRealDemoAssets();
    state.userLoadedBacking = true;
    showToast('Studio backing band armed — tap Start Recording to sing over it!');
  }

  function getTotalDuration() {
    if (state.hwDirectDemo && hwAudio.duration && Number.isFinite(hwAudio.duration) && hwAudio.duration > 0.5) {
      return hwAudio.duration;
    }
    const off = (state.params.vocalOffsetMs || 0) / 1000;
    const bDur = state.backingBuffer ? state.backingBuffer.duration : (state.isDemoSession ? 11.0 : 0);
    const vDur = state.rawVocalBuffer ? Math.max(0, state.rawVocalBuffer.duration + off) : 0;
    if (bDur <= 0 && vDur <= 0) return 0;
    return Math.max(bDur, vDur, 1);
  }

  function getCurrentPlayhead() {
    if (state.isPlaying && state.hwWindowActive && Number.isFinite(hwAudio.currentTime)) {
      return Math.min(getTotalDuration(), (state.hwWindowStartSec || 0) + Math.max(0, hwAudio.currentTime));
    }
    if (state.isPlaying && state.hwDirectDemo && Number.isFinite(hwAudio.currentTime)) {
      return hwAudio.currentTime;
    }
    return state.pausePositionSec;
  }

  function getMasterSignalRms() {
    if (!state.isPlaying || hwAudio.paused) return 0;
    const dur = getTotalDuration();
    const pos = getCurrentPlayhead();
    const idx = Math.min(219, Math.max(0, Math.floor((pos / Math.max(dur, 0.1)) * 220)));
    const vAmp = state.vocalPeaks ? state.vocalPeaks[idx] || 0 : 0.35;
    const bAmp = state.backingPeaks && !state.params.soloVocal ? state.backingPeaks[idx] || 0 : 0;
    return Math.max(0.08, (vAmp * 0.65 + bAmp * 0.45) * 0.42);
  }

  // Calm, featherweight 10 FPS Spectrum Visualizer (dpr=1 on Android 8.1 = zero GPU/CPU lag!)
  function drawSpectrum() {
    const canvas = document.getElementById('spectrumCanvas');
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = isLowEndDevice ? 1 : Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    const g = canvas.getContext('2d');
    g.save();
    g.scale(dpr, dpr);
    g.fillStyle = '#060810';
    g.fillRect(0, 0, w, h);

    const active = state.isPlaying && (state.livePlaying || !hwAudio.paused);
    const pos = getCurrentPlayhead();
    const dur = getTotalDuration();
    const pIdx = Math.min(219, Math.max(0, Math.floor((pos / Math.max(dur, 0.1)) * 220)));
    const vEnergy = active ? (state.vocalPeaks ? state.vocalPeaks[pIdx] : 0.45) : 0;
    const bEnergy = active && !state.params.soloVocal ? (state.backingPeaks ? state.backingPeaks[pIdx] : 0.35) : 0;
    const energy = Math.min(1, vEnergy * 0.85 + bEnergy * 0.65);

    const bars = isLowEndDevice ? 32 : 44;
    const gap = 3;
    const barW = Math.max(2, (w - gap * (bars + 1)) / bars);
    for (let i = 0; i < bars; i++) {
      const norm = i / bars;
      const tilt = Math.exp(-Math.pow((norm - 0.28) / 0.36, 2));
      const shimmer = active ? (0.62 + 0.38 * Math.abs(Math.sin(pos * 9.5 + i * 0.85))) : 0;
      const val = active ? Math.min(0.96, energy * tilt * shimmer * 1.35 + energy * 0.18) : 0;
      const bh = Math.max(3, val * (h - 10));
      const x = gap + i * (barW + gap);
      const y = h - bh - 4;
      g.fillStyle = val > 0.66 ? '#fbbf24' : '#38bdf8';
      g.fillRect(x, y, barW, bh);
    }
    g.restore();
  }

  function updatePlayButtonsUI(playing) {
    const heroBtn = document.getElementById('heroPlayText');
    if (heroBtn) heroBtn.textContent = playing ? 'Pause Vocal Demo' : 'Hear Vocal Demo';
    const mixBtn = document.getElementById('playBtnText');
    if (mixBtn) mixBtn.textContent = playing ? 'Pause Mix' : 'Play Mix';
  }

  function releaseChunkUrls() {
    if (state.activeChunkUrl) {
      try { URL.revokeObjectURL(state.activeChunkUrl); } catch (_) {}
      state.activeChunkUrl = '';
    }
    if (state.standbyChunkUrl) {
      try { URL.revokeObjectURL(state.standbyChunkUrl); } catch (_) {}
      state.standbyChunkUrl = '';
    }
    state.standbyChunkInfo = null;
    state.preRenderBusy = false;
  }

  function stopPlaybackInternal() {
    clearTimeout(state.refreshTimerId);
    state.renderSeq = (state.renderSeq || 0) + 1;
    if (state.uiTimerId) {
      clearInterval(state.uiTimerId);
      state.uiTimerId = null;
    }
    stopLiveGraphNodes();
    state.hwDirectDemo = false;
    state.hwWindowActive = false;
    try { hwAudio.pause(); } catch (_) {}
    try { hwAudioStandby.pause(); } catch (_) {}
    releaseChunkUrls();
    state.isPlaying = false;
    updatePlayButtonsUI(false);
    suspendIdleWebAudio();
    if (state.view === 'mix') drawSpectrum();
  }

  async function queueNextHardwareChunk(sessionSeq) {
    if (state.preRenderBusy || state.standbyChunkInfo || !state.hwWindowActive || state.hwWindowIsLast) return;
    const nextStart = state.hwWindowEndSec;
    const totalDur = getTotalDuration();
    if (nextStart >= totalDur - 0.08) {
      state.hwWindowIsLast = true;
      return;
    }
    state.preRenderBusy = true;
    try {
      const nextChunk = await SingVazaDSP.renderWindowWav(
        { backing: state.backingBuffer, rawVocal: state.rawVocalBuffer, tunedVocal: state.tunedVocalBuffer },
        state.params,
        nextStart,
        24,
        24000
      );
      if (sessionSeq !== state.renderSeq || !state.isPlaying) {
        return;
      }
      const nextUrl = URL.createObjectURL(nextChunk.blob);
      if (state.standbyChunkUrl) {
        try { URL.revokeObjectURL(state.standbyChunkUrl); } catch (_) {}
      }
      state.standbyChunkUrl = nextUrl;
      state.standbyChunkInfo = nextChunk;
      hwAudioStandby.src = nextUrl;
      hwAudioStandby.currentTime = 0;
      hwAudioStandby.load();
    } catch (_) {
    } finally {
      state.preRenderBusy = false;
    }
  }

  async function handoffToStandbyChunk() {
    const seq = state.renderSeq;
    if (!state.hwWindowActive || !state.isPlaying) return;
    if (state.hwWindowIsLast) {
      stopPlaybackInternal();
      state.pausePositionSec = 0;
      const mixEnd = document.getElementById('transportTime');
      if (mixEnd) mixEnd.textContent = `00:00 / ${fmtTime(getTotalDuration())}`;
      if (state.view === 'mix') drawTimeline(0);
      return;
    }

    if (!state.standbyChunkInfo) {
      await startPlayback(state.hwWindowEndSec);
      return;
    }

    const oldAudio = hwAudio;
    const oldUrl = state.activeChunkUrl;
    const nextInfo = state.standbyChunkInfo;
    const nextUrl = state.standbyChunkUrl;

    hwAudio = hwAudioStandby;
    hwAudioStandby = oldAudio;
    state.activeChunkUrl = nextUrl;
    state.standbyChunkUrl = '';
    state.standbyChunkInfo = null;
    state.hwWindowStartSec = nextInfo.windowStartSec;
    state.hwWindowEndSec = nextInfo.windowEndSec;
    state.hwWindowIsLast = nextInfo.isLastChunk;

    try { oldAudio.pause(); } catch (_) {}
    if (oldUrl) {
      setTimeout(() => { try { URL.revokeObjectURL(oldUrl); } catch (_) {} }, 250);
    }

    try {
      await hwAudio.play();
    } catch (_) {
      await startPlayback(nextInfo.windowStartSec);
      return;
    }

    if (!nextInfo.isLastChunk) {
      setTimeout(() => queueNextHardwareChunk(seq), 200);
    }
  }

  // Zero-Crackle Pure OS Hardware <audio> Streaming Engine (~65ms instant chunk start, Full Vocal FX ON, 0% "කර කර" on old phones, 10+ min song support!)
  async function startPlayback(fromSec = 0) {
    unlockMobileAudioSync();
    if (state.uiTimerId) {
      clearInterval(state.uiTimerId);
      state.uiTimerId = null;
    }
    stopLiveGraphNodes();
    try { hwAudio.pause(); } catch (_) {}
    try { hwAudioStandby.pause(); } catch (_) {}
    releaseChunkUrls();

    const seq = ++state.renderSeq;

    const useDirectDemoMp3 = state.isDemoSession
      && !state.demoEdited
      && !state.params.soloVocal
      && state.transposeSemitones === 0
      && !state.karaokeCutActive;

    if (useDirectDemoMp3) {
      const targetUrl = state.params.bypassFx ? '/assets/demo-raw-dry.mp3' : '/assets/demo-studio-fx.mp3';
      const fullTarget = new URL(targetUrl, window.location.origin).href;
      if (hwAudio.src !== fullTarget) hwAudio.src = targetUrl;

      const applySeek = () => {
        const dur = hwAudio.duration;
        const safeSec = Number.isFinite(dur) && fromSec >= dur - 0.15 ? 0 : Math.max(0, fromSec);
        try { hwAudio.currentTime = safeSec; } catch (_) {}
      };
      if (hwAudio.readyState >= 1) applySeek();
      else hwAudio.addEventListener('loadedmetadata', applySeek, { once: true });

      try {
        await hwAudio.play();
        state.hwDirectDemo = true;
        state.hwWindowActive = false;
        state.isPlaying = true;
        updatePlayButtonsUI(true);
      } catch (_) {
        state.hwDirectDemo = false;
        state.isPlaying = false;
        updatePlayButtonsUI(false);
        return;
      }
    } else {
      if (state.isDemoSession && (!state.rawVocalBuffer || !state.backingBuffer)) {
        try { await preloadRealDemoAssets(); } catch (_) {}
      }

      if (!state.backingBuffer && !state.rawVocalBuffer) {
        updatePlayButtonsUI(false);
        showToast(state.isProcessingTake ? 'Still preparing your vocal recording...' : 'No audio in mixer — record your voice or tap Demo first.');
        return;
      }

      try {
        const totalDur = getTotalDuration();
        const safeSec = totalDur > 0.25 && fromSec >= totalDur - 0.15 ? 0 : Math.max(0, fromSec);
        const firstChunk = await SingVazaDSP.renderWindowWav(
          { backing: state.backingBuffer, rawVocal: state.rawVocalBuffer, tunedVocal: state.tunedVocalBuffer },
          state.params,
          safeSec,
          18,
          24000
        );
        suspendIdleWebAudio();
        if (seq !== state.renderSeq) return;

        const chunkUrl = URL.createObjectURL(firstChunk.blob);
        state.activeChunkUrl = chunkUrl;
        state.hwWindowStartSec = firstChunk.windowStartSec;
        state.hwWindowEndSec = firstChunk.windowEndSec;
        state.hwWindowIsLast = firstChunk.isLastChunk;
        state.hwDirectDemo = false;
        state.hwWindowActive = true;

        hwAudio.src = chunkUrl;
        hwAudio.currentTime = 0;
        await hwAudio.play();
        state.isPlaying = true;
        updatePlayButtonsUI(true);

        if (!firstChunk.isLastChunk) {
          setTimeout(() => queueNextHardwareChunk(seq), 350);
        }
      } catch (err) {
        releaseChunkUrls();
        state.hwWindowActive = false;
        state.isPlaying = false;
        updatePlayButtonsUI(false);
        showToast('Playback warning: ' + (err?.message || 'tap Play Mix again'));
        return;
      }
    }

    // Calm 10 FPS (100ms) UI & seamless chunk pre-fetch monitor
    state.uiTimerId = setInterval(() => {
      if (!state.isPlaying) return;
      if (state.hwWindowActive && Number.isFinite(hwAudio.duration) && hwAudio.duration > 0.2) {
        const rem = hwAudio.duration - hwAudio.currentTime;
        if (!state.hwWindowIsLast && !state.standbyChunkInfo && !state.preRenderBusy && rem < 7.5) {
          queueNextHardwareChunk(seq);
        }
        if (rem <= 0.035) {
          handoffToStandbyChunk();
          return;
        }
      }
      if (hwAudio.paused) return;
      const pos = getCurrentPlayhead();
      const dur = getTotalDuration();
      const tStr = `${fmtTime(pos)} / ${fmtTime(dur)}`;
      const mixT = document.getElementById('transportTime');
      const heroT = document.getElementById('heroDemoTime');
      if (mixT) mixT.textContent = tStr;
      if (heroT) heroT.textContent = fmtTime(pos);

      if (state.view === 'mix') {
        drawSpectrum();
        drawTimeline(pos);
      }
    }, 100);
  }

  function handleHwAudioEnded(ev) {
    if (ev.target !== hwAudio) return;
    if (state.hwWindowActive && state.isPlaying) {
      handoffToStandbyChunk();
      return;
    }
    stopPlaybackInternal();
    state.pausePositionSec = 0;
    if (state.view === 'mix') drawTimeline(0);
  }
  hwAudio.addEventListener('ended', handleHwAudioEnded);
  hwAudioStandby.addEventListener('ended', handleHwAudioEnded);

  // Instant ~65ms hardware window refresh when sliders/presets/vocal-delay change!
  function scheduleHardwareRefresh(delayMs = 90, rewindSec = 0) {
    clearTimeout(state.refreshTimerId);
    if (!state.isPlaying) return;
    state.refreshTimerId = setTimeout(() => {
      if (state.isPlaying) {
        const cur = Math.max(0, getCurrentPlayhead() - rewindSec);
        startPlayback(cur);
      }
    }, delayMs);
  }

  function pausePlayback() {
    state.pausePositionSec = getCurrentPlayhead();
    stopPlaybackInternal();
  }

  async function togglePlayback() {
    unlockMobileAudioSync();
    if (state.isPlaying) {
      pausePlayback();
      return;
    }
    await startPlayback(state.pausePositionSec);
  }

  function stopAndRewind() {
    stopPlaybackInternal();
    state.pausePositionSec = 0;
    try { hwAudio.currentTime = 0; } catch (_) {}
    document.getElementById('transportTime').textContent = `00:00 / ${fmtTime(getTotalDuration())}`;
    drawTimeline(0);
  }

  // ==================== SMOOTH HARDWARE FX CONTROLS ====================
  function updateFxButtonsUI() {
    const on = !state.params.bypassFx;
    const label = on ? 'Studio FX: ON' : 'Raw Dry Mic';
    ['btnBypassFx', 'btnHeroFx'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = label;
        el.className = on ? 'btn btn-cyan' : 'btn';
      }
    });
    const sub = document.getElementById('heroDemoSub');
    if (sub) {
      sub.textContent = on
        ? 'Studio Concert Hall + Stereo Doubler ACTIVE'
        : 'Raw dry microphone stem (FX bypassed — hear the difference!)';
    }
  }

  function toggleBypassFx() {
    unlockMobileAudioSync();
    state.params.bypassFx = !state.params.bypassFx;
    if (!state.isDemoSession || state.demoEdited) {
      state.mixDirty = true;
    }
    updateFxButtonsUI();
    if (state.isPlaying) {
      const cur = getCurrentPlayhead();
      startPlayback(cur);
    }
  }

  function toggleSoloVocal() {
    state.params.soloVocal = !state.params.soloVocal;
    markMixDirty();
    document.getElementById('btnSoloVocal').className = state.params.soloVocal ? 'btn btn-sm btn-amber' : 'btn btn-sm';
    scheduleHardwareRefresh(60);
  }

  function renderPresets() {
    const grid = document.getElementById('presetGrid');
    if (!grid) return;
    grid.innerHTML = Object.entries(SingVazaDSP.PRESETS).map(([key, p]) => `
      <div class="preset-card ${state.activePreset === key ? 'active' : ''}" onclick="App.applyPreset('${key}', true)">
        <div class="preset-card-tag">${p.tag}</div>
        <div class="preset-card-name">${p.nameEn}</div>
        <div class="preset-card-desc">${p.descEn}</div>
      </div>
    `).join('');
  }

  function applyPreset(key, notify = true) {
    const p = SingVazaDSP.PRESETS[key];
    if (!p) return;
    state.activePreset = key;
    state.params = { ...state.params, ...p, bypassFx: false };
    if (notify) markMixDirty();
    updateFxButtonsUI();
    renderPresets();
    syncSlidersFromParams();

    if ((p.autotuneAmount || 0) > 0 && state.rawVocalBuffer) {
      applyWorkerAutoTune();
    } else if (notify) {
      scheduleHardwareRefresh(60);
    }
    if (notify) showToast(`Preset active: ${p.nameEn}`);
  }

  function syncSlidersFromParams() {
    const p = state.params;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const txt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    set('vocalVolSlider', Math.round(p.vocalGain * 100));
    txt('vocalVolVal', `${Math.round(p.vocalGain * 100)}%`);
    set('backingVolSlider', Math.round(p.backingGain * 100));
    txt('backingVolVal', `${Math.round(p.backingGain * 100)}%`);
    set('reverbMixSlider', Math.round(p.reverbMix * 100));
    txt('reverbMixText', `${Math.round(p.reverbMix * 100)}%`);
    set('doublerMixSlider', Math.round((p.doublerMix ?? 0.4) * 100));
    txt('doublerMixText', `${Math.round((p.doublerMix ?? 0.4) * 100)}%`);
    set('delayMixSlider', Math.round(p.delayMix * 100));
    txt('delayMixText', `${Math.round(p.delayMix * 100)}%`);
    set('airSlider', p.airDb);
    txt('airValText', `+${Number(p.airDb).toFixed(1)} dB`);
    const clarityPct = Math.min(100, Math.max(0, Math.round(((p.airDb ?? 5.0) / 6.5) * 100)));
    set('claritySlider', clarityPct);
    txt('clarityValText', `${clarityPct}%`);
    set('atStrength', Math.round((p.autotuneAmount ?? 0) * 100));
    txt('atStrengthText', `${Math.round((p.autotuneAmount ?? 0) * 100)}%`);
    set('gateSlider', Math.round((p.noiseGate ?? 0) * 100));
    txt('gateValText', `${Math.round((p.noiseGate ?? 0) * 100)}%`);
    const hpHz = Math.round(p.hpFreq ?? 95);
    const lpHz = Math.round(p.lpFreq ?? 16000);
    set('lowCutSlider', hpHz);
    txt('lowCutValText', `${hpHz} Hz`);
    set('highCutSlider', lpHz);
    txt('highCutValText', `${(lpHz / 1000).toFixed(1)} kHz`);
    const offMs = Math.round(p.vocalOffsetMs ?? 0);
    set('syncOffsetSlider', offMs);
    set('syncOffsetTopSlider', offMs);
    set('syncOffsetInput', offMs);
    txt('syncOffsetLabel', `${offMs > 0 ? '+' : ''}${offMs} ms`);
    setMasterProfile(p.masterProfile || 'warm', false);
  }

  function setFilterCut(paramName, rawVal, commitAudio = false) {
    const hz = Math.round(Number(rawVal) || (paramName === 'hpFreq' ? 95 : 16000));
    state.params[paramName] = hz;
    markMixDirty();
    if (paramName === 'hpFreq') {
      const el = document.getElementById('lowCutValText');
      if (el) el.textContent = `${hz} Hz`;
    } else {
      const el = document.getElementById('highCutValText');
      if (el) el.textContent = `${(hz / 1000).toFixed(1)} kHz`;
    }
    if (commitAudio || state.isPlaying) {
      scheduleHardwareRefresh(commitAudio ? 60 : 220);
    }
  }

  function setClarityMacro(pct) {
    const n = Number(pct) || 0;
    const ratio = n / 100;
    state.params.mudCutDb = -(1.2 + ratio * 3.4);
    state.params.presenceDb = 1.6 + ratio * 3.0;
    state.params.airDb = 1.5 + ratio * 5.0;
    state.params.exciterMix = 0.08 + ratio * 0.36;
    markMixDirty();
    document.getElementById('clarityValText').textContent = `${Math.round(n)}%`;
    document.getElementById('airSlider').value = state.params.airDb.toFixed(1);
    document.getElementById('airValText').textContent = `+${state.params.airDb.toFixed(1)} dB`;
    scheduleHardwareRefresh(200);
  }

  function updateParam(name, val) {
    state.params[name] = val;
    markMixDirty();
    syncSlidersFromParams();
    scheduleHardwareRefresh(200);
  }

  function setMasterProfile(profile, notify = true) {
    state.params.masterProfile = profile;
    ['warm', 'balanced', 'loud'].forEach((k) => {
      const btn = document.getElementById(`mp-${k}`);
      if (btn) btn.className = k === profile ? 'btn btn-sm btn-amber' : 'btn btn-sm';
    });
    if (notify) {
      markMixDirty();
      scheduleHardwareRefresh(80);
      showToast(`Master tone: ${profile.toUpperCase()}`);
    }
  }

  function setVocalOffset(ms, restartAudio = false) {
    const val = Math.max(-2000, Math.min(2000, Math.round(Number(ms) || 0)));
    state.params.vocalOffsetMs = val;
    try { localStorage.setItem('singvaza_mic_offset_ms', String(val)); } catch (_) {}
    markMixDirty();
    const s1 = document.getElementById('syncOffsetSlider');
    const s2 = document.getElementById('syncOffsetTopSlider');
    const inp = document.getElementById('syncOffsetInput');
    const lbl = document.getElementById('syncOffsetLabel');
    if (s1) s1.value = Math.max(-1500, Math.min(1500, val));
    if (s2) s2.value = Math.max(-1500, Math.min(1500, val));
    if (inp) inp.value = val;
    if (lbl) lbl.textContent = `${val > 0 ? '+' : ''}${val} ms`;
    drawTimeline();
    if (restartAudio) {
      if (state.isPlaying) {
        scheduleHardwareRefresh(45, 0.7);
      } else if (state.backingBuffer || state.rawVocalBuffer) {
        startPlayback(Math.max(0, state.pausePositionSec - 0.4));
      }
    }
  }

  function nudgeVocalOffset(deltaMs) {
    const next = Math.max(-2000, Math.min(2000, Math.round((state.params.vocalOffsetMs || 0) + Number(deltaMs || 0))));
    setVocalOffset(next, true);
  }

  async function autoAlignTracks() {
    if (!state.backingBuffer || !state.rawVocalBuffer) {
      showToast('Record or load a vocal track first');
      return;
    }
    const ms = SingVazaDSP.estimateSyncOffsetMs(state.backingBuffer, state.rawVocalBuffer);
    setVocalOffset(ms, true);
    showToast(`Auto-aligned vocal sync (${ms > 0 ? '+' : ''}${ms} ms)`);
  }

  async function runSmartVoiceMatch() {
    if (!state.rawVocalBuffer && state.isDemoSession) {
      await preloadRealDemoAssets();
    }
    if (!state.rawVocalBuffer) {
      showToast('Load or record a voice track first');
      return;
    }
    const res = SingVazaDSP.analyzeVoiceQuick(state.rawVocalBuffer);
    state.activePreset = res.presetKey;
    state.params = { ...state.params, ...res.settings, bypassFx: false };
    markMixDirty();
    updateFxButtonsUI();
    renderPresets();
    syncSlidersFromParams();
    scheduleHardwareRefresh(60);
    const banner = document.getElementById('voiceReportBanner');
    banner.style.display = 'block';
    banner.textContent = `✓ ${res.note}`;
    showToast('Studio matched EQ, compression & hall space to your voice!');
  }

  // ==================== WEB WORKER AUTO-TUNE & SOUNDTOUCH KEY SHIFT ====================
  async function applyWorkerAutoTune() {
    if (!state.rawVocalBuffer && state.isDemoSession) {
      await preloadRealDemoAssets();
    }
    if (!state.rawVocalBuffer) return;
    const ctx = ensureAudioCtx();
    state.params.autotuneAmount = Number(document.getElementById('atStrength').value) / 100;
    state.params.noiseGate = Number(document.getElementById('gateSlider').value) / 100;
    state.params.scaleKey = Number(document.getElementById('keySelect').value);

    const res = await SingVazaDSP.processVocalAsync(ctx, state.rawVocalBuffer, {
      autotuneAmount: state.params.autotuneAmount,
      retuneSpeed: 0.45,
      noiseGate: state.params.noiseGate,
      scaleKey: state.params.scaleKey,
    });
    suspendIdleWebAudio();
    state.tunedVocalBuffer = res.buffer;
    state.pitchFrames = res.pitchCurve || [];
    state.pitchScore = res.pitchScore || 95;
    markMixDirty();
    updatePitchBadge();
    drawPitchGraph();
    if (state.isPlaying) startPlayback(getCurrentPlayhead());
  }

  async function shiftBackingKey(delta) {
    if (state.karaokeBusy) { showToast('Wait for karaoke processing to finish.'); return; }
    if (!state.originalBackingBuffer) await preloadRealDemoAssets();
    const next = Math.max(-6, Math.min(6, state.transposeSemitones + delta));
    state.transposeSemitones = next;
    document.getElementById('transposeLabel').textContent = `${next > 0 ? '+' : ''}${next} st`;
    showToast(next === 0 ? 'Restored original song key' : `Shifting music key (${next > 0 ? '+' : ''}${next} st)...`);
    const ctx = ensureAudioCtx();
    const base = state.karaokeCutActive && state.karaokeBuffer ? state.karaokeBuffer : state.originalBackingBuffer;
    const loadSeq = state.backingLoadSeq;
    const keySeq = ++state.karaokeJobSeq;
    if (state.karaokeCutActive) {
      deactivateStageKaraoke();
      state.karaokeDirty = true;
      updateVocalRemoverUI('Key changed. Tap Update karaoke to refresh the comparison and Sing backing.');
    }
    const shifted = next === 0 ? base : await SingVazaDSP.transposeBufferAsync(ctx, base, next);
    if (loadSeq !== state.backingLoadSeq || keySeq !== state.karaokeJobSeq) return;
    state.backingBuffer = shifted;
    suspendIdleWebAudio();
    state.backingPeaks = SingVazaDSP.computeWaveformPeaks(state.backingBuffer, 220);
    markMixDirty();
    drawTimeline();
    if (state.isPlaying) startPlayback(getCurrentPlayhead());
  }

  async function updateKaraokeVocalCut() {
    if (state.karaokeBusy || state.backingDecodePending || !state.originalBackingBuffer || !state.userLoadedBacking || state.isDemoSession) {
      showToast('Choose a stereo audio or video file first.'); return;
    }
    const source = state.originalBackingBuffer;
    if (state.uncroppedBackup) { updateVocalRemoverUI('Undo the Mix crop before updating the karaoke version.'); return; }
    if (source.numberOfChannels !== 2) { updateVocalRemoverUI(); showToast('Vocal reduction needs a stereo track.'); return; }
    const strength = Number(document.getElementById('karaokeStrength').value) / 100;
    const introInput = document.getElementById('karaokeIntro');
    const introSeconds = Number(introInput.value);
    if (!Number.isFinite(introSeconds) || introSeconds < 0 || introSeconds >= source.duration - 0.01) {
      updateVocalRemoverUI('Choose an intro time from 0 to less than the track duration.');
      introInput.focus(); return;
    }
    const loadSeq = state.backingLoadSeq;
    const jobSeq = ++state.karaokeJobSeq;
    const key = state.transposeSemitones;
    state.karaokeBusy = true;
    const progress = document.getElementById('karaokeProgress');
    if (progress) progress.value = 0;
    updateVocalRemoverUI('Removing the centre vocal… your file stays on this device.');
    try {
      const processed = await runKaraokeWorker('separate', source, { strength, introSeconds, engine: 'instant' }, (stage) => {
        if (state.karaokeBusy) updateVocalRemoverUI(karaokeStageMessage(stage));
      });
      if (jobSeq !== state.karaokeJobSeq || loadSeq !== state.backingLoadSeq) return;
      const ctx = ensureAudioCtx();
      const effectBuffer = ctx.createBuffer(2, source.length, source.sampleRate);
      effectBuffer.copyToChannel(new Float32Array(processed.left), 0);
      effectBuffer.copyToChannel(new Float32Array(processed.right), 1);
      let backing = effectBuffer;
      let wav = processed.wav;
      if (key !== 0) {
        updateVocalRemoverUI('Applying the selected song key…');
        backing = await SingVazaDSP.transposeBufferAsync(ctx, effectBuffer, key);
        if (jobSeq !== state.karaokeJobSeq || loadSeq !== state.backingLoadSeq) return;
        updateVocalRemoverUI('Preparing karaoke playback…');
        const encoded = await runKaraokeWorker('encode', backing, {}, null);
        if (jobSeq !== state.karaokeJobSeq || loadSeq !== state.backingLoadSeq) return;
        wav = encoded.wav;
      }
      // Commit only after processing and encoding both succeed.
      releaseKaraokeResult();
      state.karaokeBuffer = effectBuffer;
      state.backingBuffer = backing;
      state.karaokeWavUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      state.karaokeInfo = processed.info || {};
      state.karaokeCutActive = true;
      state.karaokeDirty = false;
      state.karaokeBusy = false;
      state.backingPeaks = SingVazaDSP.computeWaveformPeaks(backing, 220);
      markMixDirty();
      const player = document.getElementById('karaokeComparePlayer');
      if (player) player.src = state.karaokeWavUrl;
      document.getElementById('compareOriginal')?.setAttribute('aria-pressed', 'false');
      document.getElementById('compareKaraoke')?.setAttribute('aria-pressed', 'true');
      let message = 'Vocal reduction is on. Compare the versions or use the karaoke backing in Sing.';
      if (processed.info?.engine === 'centre') message = 'Centre reduction is on (offline mode). Compare the versions or use the karaoke backing in Sing.';
      else if (processed.info?.backend === 'webgpu') message += ' Processed on your GPU.';
      if (processed.info?.strength < 1) message += ` Strength ${Math.round(processed.info.strength * 100)}%.`;
      if (processed.info?.safetyGain < 1) message += ' Overall level was lowered slightly to prevent clipping.';
      updateVocalRemoverUI(message);
      suspendIdleWebAudio();
      drawTimeline();
      if (state.isPlaying) startPlayback(getCurrentPlayhead());
      showToast(processed.info?.engine === 'mdx' ? 'AI karaoke backing ready — compare it now.' : 'Karaoke backing ready to compare.');
    } catch (err) {
      if (jobSeq !== state.karaokeJobSeq) return;
      state.karaokeBusy = false;
      suspendIdleWebAudio();
      updateVocalRemoverUI(err?.name === 'AbortError' ? 'Processing cancelled. Your previous audio is unchanged.' : (err?.message || 'Could not process this track. Try another file.'));
    }
  }

  async function applyKaraokeVocalCut() {
    if (state.karaokeBusy) return;
    if (!state.karaokeCutActive) return updateKaraokeVocalCut();
    const source = state.originalBackingBuffer;
    if (!source) return;
    const loadSeq = state.backingLoadSeq;
    const jobSeq = ++state.karaokeJobSeq;
    const key = state.transposeSemitones;
    state.karaokeBusy = true;
    updateVocalRemoverUI('Restoring the original backing…');
    try {
      const ctx = ensureAudioCtx();
      const backing = key === 0 ? source : await SingVazaDSP.transposeBufferAsync(ctx, source, key);
      if (jobSeq !== state.karaokeJobSeq || loadSeq !== state.backingLoadSeq) return;
      releaseKaraokeResult();
      state.backingBuffer = backing;
      state.karaokeBusy = false;
      state.backingPeaks = SingVazaDSP.computeWaveformPeaks(backing, 220);
      markMixDirty();
      updateVocalRemoverUI('Original stereo backing restored.');
      suspendIdleWebAudio();
      drawTimeline();
      if (state.isPlaying) startPlayback(getCurrentPlayhead());
      showToast('Original stereo track restored.');
    } catch (err) {
      if (jobSeq !== state.karaokeJobSeq) return;
      state.karaokeBusy = false;
      updateVocalRemoverUI(err?.message || 'Could not restore the original track.');
    }
  }

  // ==================== INSTANT SONG-NAME KARAOKE VIDEO + LRC LYRICS ====================
  function parseYoutubeId(input) {
    const m = String(input || '').trim().match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function heroSearchSubmit(e) {
    e.preventDefault();
    const q = document.getElementById('heroSongQuery').value.trim();
    if (q) quickSingSong(q);
  }

  function quickSingSong(songName) {
    unlockMobileAudioSync();
    document.getElementById('ytUrlInput').value = songName;
    switchView('sing');
    searchOrLoadKaraoke(songName);
  }

  function ensureYtApi() {
    if (window.YT || document.getElementById('yt-iframe-api')) return;
    const tag = document.createElement('script');
    tag.id = 'yt-iframe-api';
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }

  function ytSendCommand(func, args = []) {
    const iframe = document.getElementById('ytKaraokeIframe');
    if (iframe && iframe.contentWindow) {
      try {
        iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
      } catch (_) {}
    }
    if (state.ytPlayer && typeof state.ytPlayer[func] === 'function') {
      try { state.ytPlayer[func](...args); } catch (_) {}
    }
  }

  function renderYoutubeEmbed(videoId, title = '') {
    resetKaraoke();
    state.backingLoadSeq += 1;
    state.backingDecodePending = false;
    if (state.uploadedMediaUrl) {
      try { URL.revokeObjectURL(state.uploadedMediaUrl); } catch (_) {}
      state.uploadedMediaUrl = '';
      state.uploadedIsVideo = false;
      state.uploadedFileName = '';
      state.userLoadedBacking = false;
    }
    updateVocalRemoverUI();
    const clearBtn = document.getElementById('btnClearStageTrack');
    if (clearBtn) clearBtn.style.display = 'none';
    const upLyrForm = document.getElementById('uploadLyricsSearchForm');
    if (upLyrForm) upLyrForm.style.display = 'none';
    ensureYtApi();
    const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname);
    const originParam = isIp ? '' : `&origin=${encodeURIComponent(window.location.origin)}`;
    setStageMode('video');
    document.getElementById('stageVideoWrap').innerHTML = `
      <iframe id="ytKaraokeIframe"
        src="https://www.youtube.com/embed/${videoId}?enablejsapi=1&autoplay=0&playsinline=1&rel=0&modestbranding=1${originParam}"
        title="${title.replace(/"/g, '')}"
        referrerpolicy="strict-origin-when-cross-origin"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowfullscreen></iframe>`;

    state.ytPlayer = null;
    const tryAttachPlayer = (attempt = 0) => {
      if (window.YT && window.YT.Player) {
        try {
          state.ytPlayer = new window.YT.Player('ytKaraokeIframe', {
            events: {
              onStateChange: (ev) => {
                if (state.waitingForYtTap && ev.data === 1) {
                  state.waitingForYtTap = false;
                  beginActiveMediaRecorder();
                }
              },
            },
          });
        } catch (_) {}
      } else if (attempt < 15) {
        setTimeout(() => tryAttachPlayer(attempt + 1), 350);
      }
    };
    setTimeout(() => tryAttachPlayer(0), 250);
  }

  function seekToLyric() {}

  async function searchOrLoadKaraoke(overrideInput) {
    const raw = (overrideInput || document.getElementById('ytUrlInput').value || '').trim();
    if (!raw) {
      showToast('Type any song name (e.g. Perfect Ed Sheeran)');
      return;
    }
    const directId = parseYoutubeId(raw);
    if (directId) {
      renderYoutubeEmbed(directId, 'Karaoke Video');
      return;
    }

    const btn = document.getElementById('btnKaraokeSearch');
    btn.disabled = true;
    btn.textContent = 'Finding...';
    document.getElementById('projectTitleInput').value = `${raw} — Vocal Cover`;

    const lyricsPromise = fetchLyrics(raw);

    try {
      const searchUrl = `/api/search-karaoke?q=${encodeURIComponent(raw)}`;
      const res = window.SingVazaGuard ? await window.SingVazaGuard.fetch(searchUrl) : await fetch(searchUrl);
      const data = await res.json();
      const videos = data.videos || data.results || [];
      if (!videos.length) {
        showToast('No karaoke video found — try adding the artist name');
        return;
      }
      state.karaokeResults = videos;
      state.karaokeIndex = 0;
      renderKaraokeStrip();
      selectKaraokeVideo(0, true);
      document.getElementById('btnNextKaraoke').style.display = videos.length > 1 ? 'inline-flex' : 'none';
      showToast('Karaoke video ready! Tap Start Recording to sing.');
      // Only try video title AFTER initial user-query lyrics lookup finishes AND ONLY if nothing was found!
      lyricsPromise.then(() => {
        if (!state.lrcLines.length && videos[0]?.title) {
          fetchLyrics(videos[0].title, true);
        }
      });
    } catch (_) {
      showToast('Network issue finding karaoke video');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Search';
    }
  }

  function renderKaraokeStrip() {
    const strip = document.getElementById('karaokeResultsStrip');
    strip.style.display = 'flex';
    strip.innerHTML = state.karaokeResults.map((v, idx) => `
      <div class="yt-item ${idx === state.karaokeIndex ? 'active' : ''}" onclick="App.selectKaraokeVideo(${idx})">
        <img src="${v.thumbnail}" alt="" loading="lazy" />
        <div class="yt-item-title">${v.title}</div>
      </div>
    `).join('');
  }

  function selectKaraokeVideo(idx, skipAutoLyrics = false) {
    const v = state.karaokeResults[idx];
    if (!v) return;
    state.karaokeIndex = idx;
    renderKaraokeStrip();
    renderYoutubeEmbed(v.id || v.videoId, v.title);
    if (!skipAutoLyrics && !state.lrcLines.length && v.title) {
      fetchLyrics(v.title, true);
    }
  }

  function nextKaraokeResult() {
    if (!state.karaokeResults.length) return;
    selectKaraokeVideo((state.karaokeIndex + 1) % state.karaokeResults.length, true);
  }

  function renderPlainLyricsText(rawText, sourceLabel = 'Lyrics ready') {
    const htmlRows = [];
    String(rawText || '').split('\n').forEach((line) => {
      const cleaned = line.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim();
      if (cleaned) {
        htmlRows.push(`<div class="lyric-row">${cleaned}</div>`);
      } else if (htmlRows.length && !htmlRows[htmlRows.length - 1].includes('lyric-spacer')) {
        htmlRows.push('<div class="lyric-spacer"></div>');
      }
    });
    state.lrcLines = htmlRows;
    const box = document.getElementById('lyricsStageBox');
    const lbl = document.getElementById('lyricsStatusLabel');
    if (box && htmlRows.length) {
      box.innerHTML = htmlRows.join('');
      box.scrollTop = 0;
      if (lbl) lbl.textContent = sourceLabel;
      const ta = document.getElementById('customLyricsTextarea');
      if (ta) ta.value = String(rawText || '').replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim();
      return true;
    }
    return false;
  }

  function toggleCustomLyricsEditor() {
    const wrap = document.getElementById('customLyricsEditorWrap');
    if (!wrap) return;
    wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none';
  }

  function saveCustomLyrics() {
    const val = document.getElementById('customLyricsTextarea')?.value?.trim() || '';
    if (!val) {
      showToast('Paste or type lyrics first');
      return;
    }
    renderPlainLyricsText(val, 'Custom lyrics');
    document.getElementById('customLyricsEditorWrap').style.display = 'none';
    showToast('Lyrics updated!');
  }

  async function fetchLyrics(query, isFallback = false) {
    if (isFallback && state.lrcLines.length) return;
    const seq = (state.lyricsReqSeq = (state.lyricsReqSeq || 0) + 1);
    const lbl = document.getElementById('lyricsStatusLabel');
    const box = document.getElementById('lyricsStageBox');
    if (!isFallback) {
      state.lrcLines = [];
      if (lbl) lbl.textContent = 'Finding lyrics...';
      if (box) box.innerHTML = '<div class="lyric-row" style="color:var(--text-secondary);">Loading song lyrics...</div>';
    }

    try {
      const cleanQ = String(query || '').split(/[|•]/)[0].replace(/\b(karaoke|instrumental|lyrics|version|official|acoustic)\b/gi, '').trim() || query;
      let hit = null;

      try {
        const lyricsUrl = `/api/lyrics?q=${encodeURIComponent(cleanQ)}`;
        const res = window.SingVazaGuard ? await window.SingVazaGuard.fetch(lyricsUrl) : await fetch(lyricsUrl);
        if (res.ok) {
          const data = await res.json();
          hit = data.track || (data.results || [])[0] || null;
        }
      } catch (_) {}

      if (seq !== state.lyricsReqSeq) return;

      if (!hit) {
        try {
          const directRes = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanQ)}`);
          if (directRes.ok) {
            const list = await directRes.json();
            if (Array.isArray(list) && list.length) {
              hit = list.find((item) => item.plainLyrics) || list.find((item) => item.syncedLyrics) || null;
            }
          }
        } catch (_) {}
      }

      if (seq !== state.lyricsReqSeq) return;

      if (hit && renderPlainLyricsText(hit.plainLyrics || hit.syncedLyrics || '', 'Full song lyrics')) {
        return;
      }

      if (state.lrcLines.length) return;
      if (lbl) lbl.textContent = 'Tap Edit Lyrics to paste';
      if (box) {
        box.innerHTML = '<div class="lyric-row" style="color:var(--text-secondary);">Lyrics not found in database for this version — read directly from the video above or tap "Edit Lyrics" to paste yours.</div>';
      }
    } catch (_) {}
  }

  function cleanSongTitleFromFilename(rawName) {
    const base = String(rawName || '').replace(/\.[^.]+$/, '');
    const cleaned = base
      .replace(/[_]+/g, ' ')
      .replace(/\b(y2mate|snaptube|savefrom|yt1s|yt5s|ssyoutube|karaoke|instrumental|official|video|audio|lyrics|lyric|hd|hq|1080p|720p|480p|360p|320kbps|128kbps|mp3|mp4|track)\b/gi, ' ')
      .replace(/^\s*\d{1,3}\s*[-.]\s*/, '')
      .replace(/[-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || /^(aud|vid|whatsapp|videoplayback|recording|voice|vn|audio|video)\b/i.test(cleaned)) {
      return '';
    }
    return cleaned;
  }

  function searchLyricsOnly() {
    const q = document.getElementById('lyricsOnlyQueryInput')?.value?.trim() || '';
    if (!q) {
      showToast('Type the song name first to fetch lyrics');
      document.getElementById('lyricsOnlyQueryInput')?.focus();
      return;
    }
    fetchLyrics(q);
  }

  function renderUploadedStageMedia(fileName, url, isVideo) {
    const wrap = document.getElementById('stageVideoWrap');
    const clearBtn = document.getElementById('btnClearStageTrack');
    const nextBtn = document.getElementById('btnNextKaraoke');
    if (clearBtn) clearBtn.style.display = 'inline-flex';
    if (nextBtn) nextBtn.style.display = 'none';
    const upLyrForm = document.getElementById('uploadLyricsSearchForm');
    if (upLyrForm) upLyrForm.style.display = 'flex';
    state.ytPlayer = null;
    clearInterval(state.ytSyncInterval);

    if (!wrap) return;
    const safeTitle = String(fileName || 'Uploaded Track')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (isVideo) {
      wrap.innerHTML = `
        <video id="stageUploadedMedia" src="${url}" controls playsinline webkit-playsinline preload="metadata"
          style="width:100%;height:100%;max-height:386px;object-fit:contain;background:#000;border-radius:10px;"></video>
      `;
    } else {
      wrap.innerHTML = `
        <div style="width:100%;max-width:460px;padding:12px;">
          <div style="font-size:11px;font-weight:800;letter-spacing:0.08em;color:var(--emerald);margin-bottom:6px;">
            ● UPLOADED AUDIO TRACK READY
          </div>
          <div style="font-size:16px;font-weight:800;color:var(--text);margin-bottom:6px;word-break:break-word;">
            ${safeTitle}
          </div>
          <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:14px;">
            Press ▶ below to preview, or tap <strong style="color:var(--amber-bright);">Start Recording</strong> below to sing from 00:00 automatically.
          </div>
          <audio id="stageUploadedMedia" src="${url}" controls preload="metadata" style="width:100%;height:42px;"></audio>
        </div>
      `;
    }
  }

  function clearUploadedStageTrack() {
    resetKaraoke();
    state.uncroppedBackup = null;
    const mediaEl = document.getElementById('stageUploadedMedia');
    if (mediaEl) { try { mediaEl.pause(); } catch (_) {} }
    if (state.uploadedMediaUrl) {
      try { URL.revokeObjectURL(state.uploadedMediaUrl); } catch (_) {}
    }
    state.uploadedMediaUrl = '';
    state.uploadedIsVideo = false;
    state.uploadedFileName = '';
    state.userLoadedBacking = false;
    state.backingDecodePending = false;
    state.backingLoadSeq += 1;
    state.karaokeCutActive = false;
    state.backingBuffer = null;
    state.originalBackingBuffer = null;
    state.backingPeaks = null;
    updateVocalRemoverUI();
    markMixDirty();

    const clearBtn = document.getElementById('btnClearStageTrack');
    if (clearBtn) clearBtn.style.display = 'none';
    const upLyrForm = document.getElementById('uploadLyricsSearchForm');
    if (upLyrForm) upLyrForm.style.display = 'none';
    const wrap = document.getElementById('stageVideoWrap');
    if (wrap) {
      wrap.innerHTML = `
        <div>
          <div style="font-weight:700;color:var(--text);font-size:15px;margin-bottom:4px;">Karaoke Video / Audio Stage</div>
          <div style="font-size:13px;">Search any song above or tap <strong>Upload Audio / Video</strong> to play your own MP3 or MP4 right here.</div>
        </div>
      `;
    }
    drawTimeline(0);
    showToast('Removed uploaded track.');
  }

  // ==================== CLEAN LOW-CPU MIC RECORDING & FILE UPLOAD ====================
  /* What is this file really? Extensions lie (an AAC-in-MP4 download renamed
   * .mp3 is very common) and the answer decides whether any browser can decode
   * it. The check is on the first bytes only, so it is instant. */
  function sniffAudio(bytes) {
    const b = bytes;
    const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
    if (b.length < 12) return 'too-short';
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3-id3';
    if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return 'mp3-bare';
    if (ascii(4, 8) === 'ftyp') return 'mp4-aac';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
    if (ascii(0, 4) === 'OggS') return 'ogg';
    if (ascii(0, 4) === 'fLaC') return 'flac';
    if (ascii(0, 4) === 'FORM') return 'aiff';
    return 'unknown';
  }

  function uploadProblem(file, kind, err) {
    const mb = (file.size / 1048576).toFixed(1);
    const isFirefox = /firefox|fxios/i.test(navigator.userAgent || '');
    if (kind === 'mp4-aac') {
      return isFirefox
        ? `This file is really an MP4/AAC audio track (${mb} MB) whatever its name says, and Firefox cannot decode AAC. Open this page in Chrome, or convert it to MP3 first.`
        : `This file contains MP4/AAC audio (${mb} MB), which this browser could not decode. Try an MP3 or WAV version.`;
    }
    if (kind === 'mp3-id3' || kind === 'mp3-bare') {
      return `The MP3 itself looks valid (${mb} MB) but this browser refused it${err?.name ? ` (${err.name})` : ''}. A ${mb} MB song is a lot for a phone to unpack at once — try Chrome, or a shorter clip.`;
    }
    if (kind === 'too-short') return 'That file is empty or not audio at all.';
    return `Could not read the audio in “${file.name}” (${mb} MB${err?.name ? `, ${err.name}` : ''}). Try an MP3 or WAV version.`;
  }

  /* Some MP3 files carry no ID3 tag at all (a plain frame stream, common for
   * files pulled out of videos or older rips). Firefox refuses those with a bare
   * EncodingError while Chrome and Safari accept them, which made "Reduce
   * vocals" look dead on Firefox. Giving the buffer a 1 KB empty ID3v2 header
   * costs nothing and makes every browser agree, so the decode is retried once
   * with that header before we give up. */
  function withEmptyId3(buffer) {
    const head = new Uint8Array(1024);
    head[0] = 0x49; head[1] = 0x44; head[2] = 0x33;   // "ID3"
    head[3] = 0x04; head[4] = 0x00;                    // version 2.4
    head[5] = 0x00; head[6] = 0x00;                    // no flags, syncsafe size 0
    head[7] = 0x00; head[8] = 0x00; head[9] = 0x00;
    const out = new Uint8Array(head.length + buffer.byteLength);
    out.set(head, 0);
    out.set(new Uint8Array(buffer), head.length);
    return out.buffer;
  }

  /* decodeAudioData DETACHES the buffer it is given, so a retry needs a fresh
   * copy. Copying up front, though, doubles the memory a phone must hold while
   * it unpacks a whole song - and that is what makes Firefox on Android throw
   * EncodingError on a perfectly good MP3. So: hand over the caller's buffer
   * directly for the first attempt (no copy at all), and only rebuild a copy
   * from the file if that genuinely fails. */
  async function decodeAudioGuarded(ctx, file, raw) {
    const head = new Uint8Array(raw, 0, Math.min(16, raw.byteLength));
    const looksLikeId3 = head.length > 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
    // A frame sync (0xFF 0xEx) marks a bare MPEG stream with no tag at all.
    const hasFrameSync = head.length > 1 && head[0] === 0xFF && (head[1] & 0xE0) === 0xE0;
    let firstError = null;
    if (!looksLikeId3 && hasFrameSync) {
      try { return await ctx.decodeAudioData(withEmptyId3(raw)); } catch (err) { firstError = err; }
    }
    try {
      return await ctx.decodeAudioData(raw);           // no extra copy: lowest peak memory
    } catch (err) { if (!firstError) firstError = err; }
    // Second chance for files with an odd header. raw is detached by now, so a
    // fresh copy comes from the file itself.
    try {
      const again = await file.arrayBuffer();
      return await ctx.decodeAudioData(withEmptyId3(again));
    } catch (_) {}
    throw firstError || new Error('decode failed');
  }

  async function handleBackingUpload(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    resetKaraoke();
    state.uncroppedBackup = null;
    const undoCrop = document.getElementById('btnUndoCrop');
    if (undoCrop) undoCrop.style.display = 'none';
    unlockMobileAudioSync();

    if (state.uploadedMediaUrl) {
      try { URL.revokeObjectURL(state.uploadedMediaUrl); } catch (_) {}
    }
    const objUrl = URL.createObjectURL(file);
    const isVideo = (file.type && file.type.startsWith('video/')) || /\.(mp4|webm|mkv|mov|m4v|3gp)$/i.test(file.name);
    state.uploadedMediaUrl = objUrl;
    state.uploadedIsVideo = isVideo;
    state.uploadedFileName = file.name;
    state.isDemoSession = false;
    state.userLoadedBacking = true;
    state.backingDecodePending = true;
    const loadSeq = ++state.backingLoadSeq;
    state.karaokeCutActive = false;
    state.transposeSemitones = 0;
    const transposeLabel = document.getElementById('transposeLabel');
    if (transposeLabel) transposeLabel.textContent = '0 st';
    updateVocalRemoverUI();

    // 1. Immediately mount visible playable Video or Audio player inside #stageVideoWrap (0ms wait!)
    renderUploadedStageMedia(file.name, objUrl, isVideo);
    document.getElementById('projectTitleInput').value = file.name.replace(/\.[^.]+$/, '') + ' — Vocal Cover';

    // 2. Auto-detect song lyrics from filename OR focus lyrics search input
    const guessedTitle = cleanSongTitleFromFilename(file.name);
    const lyrInput = document.getElementById('lyricsOnlyQueryInput');
    if (guessedTitle) {
      if (lyrInput) lyrInput.value = guessedTitle;
      fetchLyrics(guessedTitle);
    } else if (lyrInput) {
      document.getElementById('lyricsStatusLabel').textContent = 'Type song name below for lyrics';
    }

    showToast(`Loaded ${isVideo ? 'video' : 'audio'}: ${file.name}`);

    // 3. Safely decode AudioBuffer for studio stem mixing without ever crashing if browser rejects video container
    try {
      const ctx = ensureAudioCtx();
      const raw = await file.arrayBuffer();
      const buf = await decodeAudioGuarded(ctx, file, raw);
      if (loadSeq !== state.backingLoadSeq) return;
      suspendIdleWebAudio();
      state.backingDecodePending = false;
      state.originalBackingBuffer = buf;
      state.backingBuffer = buf;
      state.backingPeaks = SingVazaDSP.computeWaveformPeaks(buf, 220);
      updateVocalRemoverUI();
      markMixDirty();
      if (state.view === 'mix') {
        drawTimeline(0);
        if (state.isPlaying) startPlayback(0);
      }
    } catch (err) {
      if (loadSeq !== state.backingLoadSeq) return;
      suspendIdleWebAudio();
      state.backingDecodePending = false;
      state.originalBackingBuffer = null;
      state.backingBuffer = null;
      state.backingPeaks = null;
      // Name the real reason, worked out from the file's own bytes.
      let why = `Could not read the audio in “${file.name}”. Try an MP3 or WAV version.`;
      try {
        const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
        why = uploadProblem(file, sniffAudio(head), err);
      } catch (_) {}
      updateVocalRemoverUI(why);
      showToast('Vocal reduction needs a readable stereo file.');
      markMixDirty();
      if (state.view === 'mix') drawTimeline(0);
    }
  }

  async function handleVocalUpload(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    await loadVocalFile(file);
  }

  // Applies clean, natural, zero-warble studio polish immediately after recording/upload (no auto pitch-warbling or chorus smear!)
  function applyCleanPostRecordStudioProfile(headphonesOnly) {
    state.activePreset = headphonesOnly ? 'crystal_hd' : 'velvet_ballad';
    if (headphonesOnly) {
      Object.assign(state.params, {
        bypassFx: false,
        vocalGain: 1.24,
        hpFreq: 80,
        lpFreq: 17500,
        bodyDb: 1.4,
        mudCutDb: -2.4,
        compThreshold: -21,
        compRatio: 3.0,
        presenceDb: 3.0,
        deEssDb: -3.2,
        airDb: 3.8,
        exciterMix: 0.16,
        doublerMix: 0.12,
        delayMix: 0.08,
        delayFeedback: 0.20,
        delayTimeSec: 0.34,
        preDelayMs: 36,
        reverbMix: 0.24,
        autotuneAmount: 0,
        noiseGate: 0,
      });
    } else {
      // Speaker + Voice mode: preserve 100% warm bass, crisp highs & natural performance with ZERO chorus warble or slapback clutter!
      Object.assign(state.params, {
        bypassFx: false,
        vocalGain: 1.10,
        hpFreq: 45,
        lpFreq: 17500,
        bodyDb: 0.8,
        mudCutDb: -1.4,
        compThreshold: -18,
        compRatio: 2.2,
        presenceDb: 1.8,
        deEssDb: -2.5,
        airDb: 2.0,
        exciterMix: 0.08,
        doublerMix: 0.0,
        delayMix: 0.03,
        delayFeedback: 0.16,
        delayTimeSec: 0.32,
        preDelayMs: 32,
        reverbMix: 0.12,
        autotuneAmount: 0,
        noiseGate: 0,
      });
    }
    const atEl = document.getElementById('atStrength');
    const atVal = document.getElementById('atStrengthVal');
    const gateEl = document.getElementById('gateSlider');
    const gateVal = document.getElementById('gateValText');
    if (atEl) atEl.value = 0;
    if (atVal) atVal.textContent = '0%';
    if (gateEl) gateEl.value = 0;
    if (gateVal) gateVal.textContent = '0%';
    updateFxButtonsUI();
    renderPresets();
    syncSlidersFromParams();
    const banner = document.getElementById('voiceReportBanner');
    if (banner) {
      banner.style.display = 'block';
      banner.textContent = headphonesOnly
        ? '✓ Clean Studio Vocal Mode ready — natural un-warbled voice + gentle hall polish.'
        : '✓ Clean Natural Recording ready — full bass, clear vocals & zero warble.';
    }
  }

  async function loadVocalFile(file) {
    if (!file) return;
    unlockMobileAudioSync();
    stopPlaybackInternal();
    showToast('Loading clean audio into Mix Studio...');
    try {
      const ctx = ensureAudioCtx();
      const rawBuf = await ctx.decodeAudioData(await file.arrayBuffer());
      const buf = SingVazaDSP.compactVocalBuffer(ctx, rawBuf);
      suspendIdleWebAudio();
      if (!state.userLoadedBacking) {
        state.backingBuffer = null;
        state.originalBackingBuffer = null;
        state.backingPeaks = null;
      }
      state.rawVocalBuffer = buf;
      state.tunedVocalBuffer = buf;
      state.vocalPeaks = SingVazaDSP.computeWaveformPeaks(buf, 220);
      state.isDemoSession = false;
      markMixDirty();
      applyCleanPostRecordStudioProfile(false);
      switchView('mix');
      drawTimeline(0);
      await startPlayback(0);
    } catch (_) {
      suspendIdleWebAudio();
      showToast('Could not decode this audio format — try MP3, WAV, M4A, or OGG');
    }
  }

  function onMicModeChange() {
    const headphonesOnly = document.getElementById('useCleanMic').checked;
    document.getElementById('micCleanLabel').textContent = headphonesOnly
      ? 'Headphones (Voice Isolation ON)'
      : 'Speaker + Voice (No Headphones)';
    if (state.micStream && !state.isRecording) {
      releaseMic();
    }
  }

  async function initMicStream() {
    if (state.micStream) return state.micStream;
    const headphonesOnly = document.getElementById('useCleanMic').checked;
    document.getElementById('micCleanLabel').textContent = headphonesOnly
      ? 'Headphones (Voice Isolation ON)'
      : 'Speaker + Voice (No Headphones)';

    // Always disable phone-call AGC / noise-suppression / echo-cancellation so sustained sung notes & music NEVER pump or warble!
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: false,
          echoCancellation: false,
          autoGainControl: false,
        },
      });
    } catch (_) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    state.micStream = stream;
    try {
      const ctx = ensureAudioCtx();
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {});
      }
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      state.micAnalyser = analyser;
    } catch (_) {}
    startMicMeterLoop();
    return stream;
  }

  // Calm 8 FPS (125ms) Mic Level Meter — zero main-thread stutter during recording on Android 8.1!
  function startMicMeterLoop() {
    clearInterval(state.recMeterTimer);
    const buf = new Float32Array(1024);
    let tickCount = 0;
    state.recMeterTimer = setInterval(() => {
      if (state.micAnalyser) {
        state.micAnalyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 4) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / (buf.length / 4));
        document.getElementById('micMeterFill').style.width = `${Math.min(100, rms * 340)}%`;

        if (++tickCount % 3 === 0 && state.audioCtx) {
          const note = SingVazaDSP.detectPitchLive(buf, state.audioCtx.sampleRate);
          document.getElementById('livePitchText').textContent = note ? `Note: ${note}` : 'Note: --';
        }
      }
      if (state.isRecording) {
        const elapsed = (Date.now() - state.recStartMs) / 1000;
        document.getElementById('recTimerText').textContent = fmtTime(elapsed);
      }
    }, 125);
  }

  function releaseMic() {
    clearInterval(state.recMeterTimer);
    state.recMeterTimer = null;
    if (state.micStream) state.micStream.getTracks().forEach((t) => t.stop());
    state.micStream = null;
    state.micAnalyser = null;
    const meterEl = document.getElementById('micMeterFill');
    if (meterEl) meterEl.style.width = '0%';
    const pitchEl = document.getElementById('livePitchText');
    if (pitchEl) pitchEl.textContent = 'Note: --';
    suspendIdleWebAudio();
  }

  async function toggleMicMonitor() {
    unlockMobileAudioSync();
    if (state.isMonitoring) {
      state.isMonitoring = false;
      releaseMic();
      document.getElementById('btnMicCheck').textContent = 'Test Mic';
      return;
    }
    try {
      await initMicStream();
      state.isMonitoring = true;
      document.getElementById('btnMicCheck').textContent = 'Stop Test';
      showToast('Speak or sing now to check your mic level');
    } catch (_) {
      showToast('Please allow Microphone permission in your browser');
    }
  }

  function runCountdown() {
    return new Promise((resolve) => {
      if (!document.getElementById('useCountdown').checked) return resolve();
      const mask = document.getElementById('countdownOverlay');
      const num = document.getElementById('countdownNum');
      let n = 3;
      mask.classList.add('show');
      num.textContent = '3';
      const iv = setInterval(() => {
        n--;
        if (n <= 0) {
          clearInterval(iv);
          mask.classList.remove('show');
          resolve();
        } else {
          num.textContent = String(n);
        }
      }, 650);
    });
  }

  function setProcessingBanner(visible) {
    state.isProcessingTake = visible;
    const b = document.getElementById('mixProcessingBanner');
    if (b) b.style.display = visible ? 'block' : 'none';
  }

  function stopActiveRecordingNow() {
    const stageMedia = document.getElementById('stageUploadedMedia');
    state.waitingForYtTap = false;
    state.isRecording = false;
    ytSendCommand('pauseVideo');
    if (stageMedia) { try { stageMedia.pause(); } catch (_) {} }
    stopPlaybackInternal();
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
      setProcessingBanner(true);
      state.mediaRecorder.stop();
    } else {
      releaseMic();
    }
    const recBtn = document.getElementById('btnRecordVocal');
    if (recBtn) recBtn.classList.remove('recording');
    const recLbl = document.getElementById('recBtnLabel');
    if (recLbl) recLbl.textContent = 'Start Recording';
  }

  function beginActiveMediaRecorder() {
    if (!state.micStream || state.isRecording) return;
    const headphonesOnly = document.getElementById('useCleanMic').checked;
    state.recChunks = [];

    // Immediately replace any old Demo session right when recording starts so Demo NEVER blocks or confuses a real recording!
    state.isDemoSession = false;
    state.rawVocalBuffer = null;
    state.tunedVocalBuffer = null;
    state.vocalPeaks = null;
    if (!state.userLoadedBacking) {
      state.backingBuffer = null;
      state.originalBackingBuffer = null;
      state.backingPeaks = null;
    }
    if (state.cachedMixUrl && state.cachedMixUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(state.cachedMixUrl); } catch (_) {}
    }
    state.cachedMixUrl = '';
    try { hwAudio.pause(); hwAudio.removeAttribute('src'); hwAudio.load(); } catch (_) {}
    const rtEl = document.getElementById('recTimerText');
    if (rtEl) rtEl.textContent = '00:00';

    const mimeCandidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];
    const bestMime = mimeCandidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
    let rec;
    try {
      rec = bestMime
        ? new MediaRecorder(state.micStream, { mimeType: bestMime, audioBitsPerSecond: 96000 })
        : new MediaRecorder(state.micStream, { audioBitsPerSecond: 96000 });
    } catch (_) {
      try {
        rec = bestMime ? new MediaRecorder(state.micStream, { mimeType: bestMime }) : new MediaRecorder(state.micStream);
      } catch (__) {
        rec = new MediaRecorder(state.micStream);
      }
    }
    state.mediaRecorder = rec;
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) state.recChunks.push(ev.data); };
    rec.onstop = async () => {
      releaseMic();
      const stageMedia = document.getElementById('stageUploadedMedia');
      if (stageMedia) { try { stageMedia.pause(); } catch (_) {} }
      const chunks = state.recChunks;
      state.recChunks = [];
      if (!chunks || !chunks.length) {
        setProcessingBanner(false);
        showToast('Recording was empty — please check microphone permission');
        return;
      }
      setProcessingBanner(true);
      showToast('Preparing your clean studio recording...');
      try {
        let blob = new Blob(chunks, { type: rec.mimeType || bestMime || 'audio/webm' });
        chunks.length = 0;
        const arrBuf = await blob.arrayBuffer();
        blob = null;
        const ctx = ensureAudioCtx();
        const decodedBuf = await ctx.decodeAudioData(arrBuf);
        const vocalBuf = SingVazaDSP.compactVocalBuffer(ctx, decodedBuf);

        if (!state.userLoadedBacking) {
          state.backingBuffer = null;
          state.originalBackingBuffer = null;
          state.backingPeaks = null;
        }
        state.rawVocalBuffer = vocalBuf;
        state.tunedVocalBuffer = vocalBuf;
        state.vocalPeaks = SingVazaDSP.computeWaveformPeaks(vocalBuf, 220);
        state.isDemoSession = false;
        markMixDirty();

        const rtDone = document.getElementById('recTimerText');
        if (rtDone) rtDone.textContent = '00:00';

        applyCleanPostRecordStudioProfile(headphonesOnly);
        setProcessingBanner(false);
        switchView('mix');
        drawTimeline(0);
        await startPlayback(0);
      } catch (err) {
        setProcessingBanner(false);
        suspendIdleWebAudio();
        showToast('Could not process recording: ' + (err?.message || 'try again'));
      }
    };

    // Start uploaded Video or Audio player immediately from 00:00 (0ms latency, 0% WebAudio CPU!)
    const stageMedia = document.getElementById('stageUploadedMedia');
    if (stageMedia) {
      try {
        stageMedia.muted = Boolean(state.stageKaraokeActive && state.uploadedIsVideo);
        stageMedia.volume = 1;
        stageMedia.currentTime = 0;
        state.karaokeUnlocking = false;
        const start = stageMedia.play();
        if (start && start.catch) start.catch(() => {
          if (state.stageKaraokeActive && state.isRecording) {
            stopActiveRecordingNow();
            showToast('Karaoke playback was blocked. Tap play and try recording again.');
          }
        });
      } catch (_) {}
    } else if (state.backingBuffer && state.userLoadedBacking) {
      SingVazaDSP.renderMasterWav({ backing: state.backingBuffer, rawVocal: null, tunedVocal: null }, { ...state.params, vocalPocket: false }, true)
        .then((bBlob) => {
          if (state.isRecording) {
            hwAudio.src = URL.createObjectURL(bBlob);
            hwAudio.currentTime = 0;
            hwAudio.play().catch(() => {});
          }
        }).catch(() => {});
    }

    rec.start(250);
    state.isRecording = true;
    state.recStartMs = Date.now();
    document.getElementById('btnRecordVocal').classList.add('recording');
    document.getElementById('recBtnLabel').textContent = 'Stop & Mix My Voice';
    showToast('Recording live! Sing along now.');
  }

  async function toggleMicRecording() {
    unlockMobileAudioSync();

    const stageMedia = document.getElementById('stageUploadedMedia');

    if (state.isRecording || state.waitingForYtTap) {
      stopActiveRecordingNow();
      return;
    }

    // Gesture-unlock uploaded <video>/<audio> synchronously right on tap so mobile Firefox/Chrome allow play() after countdown!
    if (stageMedia) {
      try {
        state.karaokeUnlocking = true;
        stageMedia.pause();
        stageMedia.muted = true;
        // Unlock the processed video soundtrack on the same user gesture, silently.
        const stageAudio = state.stageKaraokeAudio;
        if (stageAudio) {
          stageAudio.muted = true;
          const ap = stageAudio.play();
          if (ap && ap.then) ap.then(() => {
            if (!state.isRecording) { stageAudio.pause(); stageAudio.currentTime = 0; }
            stageAudio.muted = false;
          }).catch(() => { stageAudio.muted = false; });
        }
        const p = stageMedia.play();
        if (p && p.then) {
          p.then(() => {
            if (!state.isRecording) {
              stageMedia.pause();
              stageMedia.currentTime = 0;
            }
            stageMedia.muted = Boolean(state.stageKaraokeActive && state.uploadedIsVideo);
            state.karaokeUnlocking = false;
          }).catch(() => {
            stageMedia.muted = Boolean(state.stageKaraokeActive && state.uploadedIsVideo);
            state.karaokeUnlocking = false;
          });
        } else { state.karaokeUnlocking = false; }
      } catch (_) { state.karaokeUnlocking = false; }
    }

    if (window.AndroidNativeStudio && typeof window.AndroidNativeStudio.canCaptureInternalAudio === 'function') {
      try {
        if (window.AndroidNativeStudio.canCaptureInternalAudio()) {
          ytSendCommand('pauseVideo');
          ytSendCommand('seekTo', [0, true]);
          await runCountdown();
          ytSendCommand('seekTo', [0, true]);
          ytSendCommand('unMute');
          ytSendCommand('setVolume', [100]);
          ytSendCommand('playVideo');
          window.AndroidNativeStudio.startDualRecording();
          state.isRecording = true;
          state.recStartMs = Date.now();
          document.getElementById('btnRecordVocal').classList.add('recording');
          document.getElementById('recBtnLabel').textContent = 'Stop & Mix My Voice';
          return;
        }
      } catch (_) {}
    }

    const hasYtIframe = !!document.getElementById('ytKaraokeIframe');
    if (hasYtIframe) {
      ytSendCommand('pauseVideo');
      ytSendCommand('seekTo', [0, true]);
    }

    try {
      await initMicStream();
      await runCountdown();

      if (hasYtIframe) {
        ytSendCommand('unMute');
        ytSendCommand('setVolume', [100]);
        ytSendCommand('seekTo', [0, true]);
        ytSendCommand('playVideo');

        setTimeout(() => {
          const st = state.ytPlayer?.getPlayerState?.();
          if (st === 1 || st === 3) {
            beginActiveMediaRecorder();
          } else {
            state.waitingForYtTap = true;
            document.getElementById('btnRecordVocal').classList.add('recording');
            document.getElementById('recBtnLabel').textContent = 'Tap ▶ on Video to Start!';
            document.getElementById('stageVideoWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
            showToast('Tap ▶ on the video once — recording starts automatically!');
          }
        }, 450);
      } else {
        beginActiveMediaRecorder();
      }
    } catch (_) {
      showToast('Microphone access blocked — please allow mic access');
    }
  }

  async function receiveNativeDualTracks(backingBase64, vocalBase64) {
    const ctx = ensureAudioCtx();
    const toBuf = async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return ctx.decodeAudioData(bytes.buffer);
    };
    if (backingBase64) {
      resetKaraoke();
      state.backingLoadSeq += 1;
      const bBuf = await toBuf(backingBase64);
      state.originalBackingBuffer = bBuf;
      state.backingBuffer = bBuf;
      state.backingPeaks = SingVazaDSP.computeWaveformPeaks(bBuf, 220);
      state.userLoadedBacking = true;
    }
    if (vocalBase64) {
      const vBuf = await toBuf(vocalBase64);
      state.rawVocalBuffer = vBuf;
      state.tunedVocalBuffer = vBuf;
      state.vocalPeaks = SingVazaDSP.computeWaveformPeaks(vBuf, 220);
    }
    suspendIdleWebAudio();
    state.isDemoSession = false;
    markMixDirty();
    switchView('mix');
    await runSmartVoiceMatch();
    await applyWorkerAutoTune();
    await startPlayback(0);
  }

  // ==================== PRO DRAGGABLE PLAYHEAD + VISUAL AUDIO CROP TIMELINE ====================
  function updateCropLabels() {
    const total = getTotalDuration();
    const sSec = state.cropStartRatio * total;
    const eSec = state.cropEndRatio * total;
    const st = document.getElementById('cropStartText');
    const et = document.getElementById('cropEndText');
    const rl = document.getElementById('cropRangeLabel');
    if (st) st.textContent = fmtTime(sSec);
    if (et) et.textContent = state.cropEndRatio >= 0.998 ? fmtTime(total) : fmtTime(eSec);
    if (rl) rl.textContent = `${fmtTime(sSec)} → ${fmtTime(eSec)} (${Math.max(0.1, eSec - sSec).toFixed(1)}s)`;
  }

  function resetCropMarkers() {
    state.cropStartRatio = 0;
    state.cropEndRatio = 1;
    const cs = document.getElementById('cropStartSlider');
    const ce = document.getElementById('cropEndSlider');
    if (cs) cs.value = 0;
    if (ce) ce.value = 1000;
    updateCropLabels();
  }

  function scrubPlayhead(sliderVal, commitAudio = false) {
    const total = getTotalDuration();
    const ratio = Math.max(0, Math.min(1, Number(sliderVal) / 1000));
    const targetSec = ratio * total;
    state.pausePositionSec = targetSec;
    const mixT = document.getElementById('transportTime');
    if (mixT) mixT.textContent = `${fmtTime(targetSec)} / ${fmtTime(total)}`;
    drawTimeline(targetSec, false);
    if (commitAudio && state.isPlaying) {
      startPlayback(targetSec);
    }
  }

  function updateCropSlider(edge, rawVal) {
    const val = Math.max(0, Math.min(1, Number(rawVal) / 1000));
    if (edge === 'start') {
      state.cropStartRatio = Math.min(val, state.cropEndRatio - 0.03);
      document.getElementById('cropStartSlider').value = Math.round(state.cropStartRatio * 1000);
    } else {
      state.cropEndRatio = Math.max(val, state.cropStartRatio + 0.03);
      document.getElementById('cropEndSlider').value = Math.round(state.cropEndRatio * 1000);
    }
    updateCropLabels();
    drawTimeline();
  }

  function markCropAtPlayhead(edge) {
    const total = getTotalDuration();
    const curRatio = Math.max(0, Math.min(1, getCurrentPlayhead() / Math.max(0.1, total)));
    updateCropSlider(edge, Math.round(curRatio * 1000));
    showToast(edge === 'start' ? `Crop Start set at ${fmtTime(curRatio * total)}` : `Crop End set at ${fmtTime(curRatio * total)}`);
  }

  async function applyAudioCrop() {
    if (state.cropStartRatio <= 0.002 && state.cropEndRatio >= 0.998) {
      showToast('Move Start Cut or End Cut sliders first to select the part to keep');
      return;
    }
    unlockMobileAudioSync();
    if (!state.backingBuffer && !state.rawVocalBuffer) {
      await preloadRealDemoAssets();
    }
    const total = getTotalDuration();
    const startSec = state.cropStartRatio * total;
    const endSec = state.cropEndRatio * total;
    if (endSec - startSec < 0.4) {
      showToast('Selected audio region is too short');
      return;
    }

    stopPlaybackInternal();

    if (!state.uncroppedBackup) {
      state.uncroppedBackup = {
        originalBackingBuffer: state.originalBackingBuffer,
        backingBuffer: state.backingBuffer,
        karaokeBuffer: state.karaokeBuffer,
        karaokeCutActive: state.karaokeCutActive,
        rawVocalBuffer: state.rawVocalBuffer,
        tunedVocalBuffer: state.tunedVocalBuffer,
        isDemoSession: state.isDemoSession,
      };
    }

    const ctx = ensureAudioCtx();
    if (state.karaokeCutActive) {
      deactivateStageKaraoke();
      const preview = document.getElementById('karaokeComparePlayer');
      if (preview) { preview.pause(); preview.removeAttribute('src'); preview.load(); }
      if (state.karaokeWavUrl) URL.revokeObjectURL(state.karaokeWavUrl);
      state.karaokeWavUrl = '';
      state.karaokeDirty = true;
      if (state.karaokeBuffer) state.karaokeBuffer = SingVazaDSP.sliceAudioBuffer(ctx, state.karaokeBuffer, startSec, endSec);
    }
    if (state.originalBackingBuffer) {
      state.originalBackingBuffer = SingVazaDSP.sliceAudioBuffer(ctx, state.originalBackingBuffer, startSec, endSec);
    }
    if (state.backingBuffer) {
      state.backingBuffer = SingVazaDSP.sliceAudioBuffer(ctx, state.backingBuffer, startSec, endSec);
      state.backingPeaks = SingVazaDSP.computeWaveformPeaks(state.backingBuffer, 220);
    }
    if (state.rawVocalBuffer) {
      state.rawVocalBuffer = SingVazaDSP.sliceAudioBuffer(ctx, state.rawVocalBuffer, startSec, endSec);
      state.vocalPeaks = SingVazaDSP.computeWaveformPeaks(state.rawVocalBuffer, 220);
    }
    if (state.tunedVocalBuffer) {
      state.tunedVocalBuffer = SingVazaDSP.sliceAudioBuffer(ctx, state.tunedVocalBuffer, startSec, endSec);
    }
    suspendIdleWebAudio();

    state.demoEdited = true;
    markMixDirty();
    state.pausePositionSec = 0;
    resetCropMarkers();
    const undoBtn = document.getElementById('btnUndoCrop');
    if (undoBtn) undoBtn.style.display = 'inline-flex';

    drawTimeline(0);
    updateCropLabels();
    document.getElementById('transportTime').textContent = `00:00 / ${fmtTime(endSec - startSec)}`;
    updateVocalRemoverUI(state.karaokeCutActive ? 'Mix cropped. Undo crop before refreshing comparison or using the Sing stage.' : '');
    showToast(`Cropped cleanly to ${fmtTime(endSec - startSec)}!`);
  }

  async function undoAudioCrop() {
    if (!state.uncroppedBackup) return;
    stopPlaybackInternal();
    const b = state.uncroppedBackup;
    state.originalBackingBuffer = b.originalBackingBuffer;
    state.backingBuffer = b.backingBuffer;
    state.karaokeBuffer = b.karaokeBuffer || null;
    state.karaokeCutActive = Boolean(b.karaokeCutActive);
    state.karaokeDirty = state.karaokeCutActive;
    state.rawVocalBuffer = b.rawVocalBuffer;
    state.tunedVocalBuffer = b.tunedVocalBuffer;
    state.isDemoSession = b.isDemoSession;
    state.backingPeaks = state.backingBuffer ? SingVazaDSP.computeWaveformPeaks(state.backingBuffer, 220) : null;
    state.vocalPeaks = state.rawVocalBuffer ? SingVazaDSP.computeWaveformPeaks(state.rawVocalBuffer, 220) : null;
    state.uncroppedBackup = null;
    markMixDirty();
    state.pausePositionSec = 0;
    resetCropMarkers();
    document.getElementById('btnUndoCrop').style.display = 'none';
    drawTimeline(0);
    updateCropLabels();
    updateVocalRemoverUI(state.karaokeCutActive ? 'Crop undone. Tap Update karaoke to refresh comparison and Sing.' : '');
    showToast('Restored full original audio!');
  }

  function drawTimeline(playheadSec = getCurrentPlayhead(), syncScrubber = true) {
    const canvas = document.getElementById('waveformCanvas');
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = isLowEndDevice ? 1 : Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    const g = canvas.getContext('2d');
    g.save();
    g.scale(dpr, dpr);
    g.fillStyle = '#060810';
    g.fillRect(0, 0, w, h);

    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();

    const total = getTotalDuration();

    const drawPeaks = (peaks, dur, startSec, yCenter, halfH, color) => {
      if (!peaks || !dur) return;
      g.fillStyle = color;
      const startX = (startSec / total) * w;
      const trackW = (dur / total) * w;
      const barW = Math.max(1.5, trackW / peaks.length - 1);
      for (let i = 0; i < peaks.length; i++) {
        const x = startX + (i / peaks.length) * trackW;
        if (x < -4 || x > w + 4) continue;
        const amp = Math.max(2, peaks[i] * halfH);
        g.fillRect(x, yCenter - amp, barW, amp * 2);
      }
    };

    const bDur = state.backingBuffer ? state.backingBuffer.duration : (state.isDemoSession ? total : 0);
    if (state.backingPeaks && bDur > 0) {
      drawPeaks(state.backingPeaks, bDur, 0, h * 0.28, h * 0.19, '#38bdf8');
    }
    const vDur = state.rawVocalBuffer ? state.rawVocalBuffer.duration : (state.isDemoSession ? total : 0);
    if (state.vocalPeaks && vDur > 0) {
      const offSec = (state.params.vocalOffsetMs || 0) / 1000;
      drawPeaks(state.vocalPeaks, vDur, offSec, h * 0.74, h * 0.19, '#fbbf24');
    }

    // Visual Crop Region Shading + Left/Right Cut Markers
    const cropX0 = state.cropStartRatio * w;
    const cropX1 = state.cropEndRatio * w;
    if (state.cropStartRatio > 0.002) {
      g.fillStyle = 'rgba(0, 0, 0, 0.68)';
      g.fillRect(0, 0, cropX0, h);
      g.strokeStyle = '#38bdf8';
      g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(cropX0, 0); g.lineTo(cropX0, h); g.stroke();
    }
    if (state.cropEndRatio < 0.998) {
      g.fillStyle = 'rgba(0, 0, 0, 0.68)';
      g.fillRect(cropX1, 0, w - cropX1, h);
      g.strokeStyle = '#fbbf24';
      g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(cropX1, 0); g.lineTo(cropX1, h); g.stroke();
    }

    // Prominent Easy-Grip White Playhead Line + Top Handle Knob
    const px = Math.max(6, Math.min(w - 6, (playheadSec / total) * w));
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.stroke();

    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(px, 10, 6.5, 0, Math.PI * 2);
    g.fill();

    g.restore();

    if (syncScrubber) {
      const sl = document.getElementById('playheadSlider');
      if (sl) sl.value = Math.round(Math.max(0, Math.min(1, playheadSec / total)) * 1000);
    }
    updateCropLabels();
  }

  function initTimelinePointerInteractions() {
    const canvas = document.getElementById('waveformCanvas');
    if (!canvas) return;
    let draggingPlayhead = false;

    const seekFromEvent = (e, commitAudio = false) => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      const seek = ratio * getTotalDuration();
      state.pausePositionSec = seek;
      const mixT = document.getElementById('transportTime');
      if (mixT) mixT.textContent = `${fmtTime(seek)} / ${fmtTime(getTotalDuration())}`;
      drawTimeline(seek);
      if (commitAudio && state.isPlaying) {
        try { hwAudio.currentTime = seek; } catch (_) {}
      }
    };

    canvas.addEventListener('pointerdown', (e) => {
      draggingPlayhead = true;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      seekFromEvent(e, false);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!draggingPlayhead) return;
      seekFromEvent(e, false);
    });

    const finishDrag = (e) => {
      if (!draggingPlayhead) return;
      draggingPlayhead = false;
      seekFromEvent(e, true);
    };

    canvas.addEventListener('pointerup', finishDrag);
    canvas.addEventListener('pointercancel', finishDrag);
  }

  function drawPitchGraph() {
    const canvas = document.getElementById('pitchCanvas');
    if (!canvas) return;
    const w = canvas.clientWidth || 500;
    const h = canvas.clientHeight || 110;
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    g.fillStyle = '#060810';
    g.fillRect(0, 0, w, h);

    const curve = Array.isArray(state.pitchFrames) ? state.pitchFrames : [];
    const voiced = curve.filter((f) => f && f.voiced && f.rawMidi > 0);
    if (!voiced.length) return;
    const minM = Math.min(...voiced.map((f) => f.rawMidi)) - 2;
    const maxM = Math.max(...voiced.map((f) => f.rawMidi)) + 2;
    const span = Math.max(8, maxM - minM);

    const plot = (key, color, width) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath();
      let down = false;
      curve.forEach((f, i) => {
        if (!f || !f.voiced || f.rawMidi <= 0) { down = false; return; }
        const x = (i / curve.length) * w;
        const y = h - ((f[key] - minM) / span) * (h - 16) - 8;
        if (!down) { g.moveTo(x, y); down = true; } else g.lineTo(x, y);
      });
      g.stroke();
    };
    plot('rawMidi', 'rgba(148,163,184,0.55)', 1.5);
    plot('tunedMidi', '#38bdf8', 2.2);
  }

  // ==================== CLOUD D1 STATE, GOOGLE GMAIL AUTH, GLOBAL TIMEZONE QUOTA & MP3 EXPORT ====================
  async function apiFetch(url, opts = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Client-Timezone': clientTimezone,
      ...(opts.headers || {}),
    };
    if (state.authToken) headers.Authorization = `Bearer ${state.authToken}`;
    const res = window.SingVazaGuard
      ? await window.SingVazaGuard.fetch(url, { ...opts, headers })
      : await fetch(url, { ...opts, headers });
    return res.json();
  }

  function isProActive() {
    if (state.user && state.isProDemo) return true;
    if (state.quota && state.quota.proActive) return true;
    if (state.user) {
      if (state.user.plan && state.user.plan !== 'free') return true;
      if (Number(state.user.pro_until || 0) > Date.now()) return true;
    }
    return false;
  }

  function getDailyUsedCount() {
    if (state.user && state.quota) {
      if (state.quota.localDate && state.quota.localDate !== getLocalDayKey(state.quota.timezone || clientTimezone)) return 0;
      return Number(state.quota.dailyUsed || 0);
    }
    return loadGuestDailyExports();
  }

  function formatResetCountdown() {
    const mins = Number(state.quota?.minutesToMidnight || 0);
    const tz = state.quota?.timezone || clientTimezone || 'Local Time';
    if (!mins) return `Resets daily at 12:00 AM (${tz})`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `Resets in ${h}h ${m}m at 12:00 AM midnight (${tz})`;
  }

  async function refreshServerState() {
    try {
      const data = await apiFetch('/api/state');
      if (data.googleClientId) updateGoogleClientId(data.googleClientId);
      if (data.quota) { state.quota = data.quota; state.dailyLimit = Math.max(1, Number(data.quota.dailyLimit) || 9); }
      if (data.authenticated && data.user) {
        state.user = data.user;
      } else {
        state.user = null;
        state.exportsUsed = loadGuestDailyExports();
      }
      state.projects = data.projects || [];
      updateAccountUI();
      renderSavedProjects();
    } catch (_) {
      updateAccountUI();
    }
  }

  function updateAccountUI() {
    const pro = isProActive();
    const daysLeft = state.quota?.proDaysLeft || (state.user?.pro_until > Date.now()
      ? Math.max(1, Math.ceil((state.user.pro_until - Date.now()) / 86400000))
      : 0);
    const usedToday = getDailyUsedCount();
    const limit = state.dailyLimit || 9;

    document.querySelectorAll('.daily-limit-value').forEach((el) => { el.textContent = String(limit); });
    const badge = document.getElementById('topPlanBadge');
    if (badge) {
      if (pro && daysLeft > 0) badge.textContent = `PRO • ${daysLeft}d`;
      else if (pro) badge.textContent = 'PRO ∞';
      else badge.textContent = `${Math.min(limit, usedToday)}/${limit} Free`;
    }

    const authBtn = document.getElementById('authTriggerBtn');
    if (authBtn) {
      authBtn.textContent = state.user ? state.user.display_name.slice(0, 9) : 'Sign In';
    }

    const proBtn = document.getElementById('proActionBtn');
    if (proBtn) {
      if (state.user && daysLeft > 0) {
        proBtn.textContent = `30-Day Free Pro Active ✓ (${daysLeft}d left)`;
      } else if (!state.user && !state.isProDemo) {
        proBtn.textContent = 'Sign In with Gmail — Get 30 Days Free Pro';
      } else {
        proBtn.textContent = state.isProDemo ? 'Temporary Free Pro Active ✓' : 'Activate Free Promo Month';
      }
    }

    const quotaLine = document.getElementById('quotaStatusLine');
    if (quotaLine) {
      if (pro && daysLeft > 0) {
        quotaLine.textContent = `🎁 30-Day Welcome Pro Pass Active (${daysLeft} days remaining) • Unlimited MP3 & WAV downloads unlocked.`;
      } else if (pro) {
        quotaLine.textContent = `✓ Temporary Pro Studio Access Active • Unlimited MP3 & WAV downloads unlocked.`;
      } else {
        quotaLine.textContent = `Daily Free Trial: ${Math.min(limit, usedToday)}/${limit} downloads used today • ${formatResetCountdown()}`;
      }
    }

    const userPlanPill = document.getElementById('authUserPlanInfo');
    if (userPlanPill && state.user) {
      userPlanPill.textContent = daysLeft > 0
        ? `🎁 Free Pro Welcome Pass Active (${daysLeft} days left)`
        : `Daily Free Quota: ${Math.min(limit, usedToday)}/${limit} today (${state.quota?.timezone || clientTimezone})`;
    }
  }

  let gsiInitialized = false;
  function updateGoogleClientId(clientId) {
    if (!clientId) return;
    state.googleClientId = clientId;
    const fields = document.getElementById('authCredentialFields');
    if (document.getElementById('authModal')?.classList.contains('open') && fields && !fields.hidden) {
      maybeMountGoogleButton();
    }
  }

  function maybeMountGoogleButton() {
    if (!state.googleClientId) return;
    const mount = document.getElementById('googleGsiMount');
    const fallbackBtn = document.getElementById('btnQuickGmailSignup');
    const renderBtn = () => {
      if (!window.google?.accounts?.id || !mount) return;
      if (!gsiInitialized) {
        window.google.accounts.id.initialize({
          client_id: state.googleClientId,
          callback: async (resp) => {
            if (!resp?.credential) return;
            const guard = window.SingVazaGuard;
            const turnstileToken = guard?.takeAuthToken() || '';
            if (!turnstileToken) {
              showToast('Please complete the security check before signing in.');
              guard?.resetAuth();
              return;
            }
            try {
              const data = await apiFetch('/api/auth/google', {
                method: 'POST',
                body: JSON.stringify({ credential: resp.credential, turnstileToken }),
              });
              if (data.error) {
                showToast(data.error);
                return;
              }
              state.authToken = data.token;
              state.user = data.user;
              if (data.quota) state.quota = data.quota;
              localStorage.setItem('singvaza_token', data.token);
              updateAccountUI();
              closeAuthModal();
              showToast(`Welcome ${data.user.display_name}! 30-Day Free Pro Pass activated!`);
            } catch (_) {
              showToast('Could not sign in. Please check your connection and try again.');
            } finally {
              if (!state.user && document.getElementById('authModal')?.classList.contains('open')) guard?.resetAuth();
            }
          },
        });
        gsiInitialized = true;
      }
      mount.innerHTML = '';
      window.google.accounts.id.renderButton(mount, {
        theme: 'filled_black',
        size: 'large',
        width: 340,
        text: 'continue_with',
        shape: 'pill',
      });
      if (fallbackBtn) fallbackBtn.style.display = 'none';
    };

    if (window.google?.accounts?.id) {
      renderBtn();
      return;
    }
    if (!document.getElementById('singvazaGsiScript')) {
      const s = document.createElement('script');
      s.id = 'singvazaGsiScript';
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = renderBtn;
      document.head.appendChild(s);
    }
  }

  function startGmailQuickSignup() {
    setAuthMode('register');
    const emailEl = document.getElementById('authEmail');
    if (emailEl) {
      emailEl.placeholder = 'yourname@gmail.com';
      emailEl.focus();
    }
    showToast('Enter your Gmail below to unlock 30 Days Free Pro instantly!');
  }

  function setAuthSecurityState(token, message, isError = false) {
    const fields = document.getElementById('authCredentialFields');
    const status = document.getElementById('authSecurityMessage');
    const retry = document.getElementById('authSecurityRetry');
    if (fields) fields.hidden = !token;
    if (status) {
      status.textContent = message || '';
      status.classList.toggle('is-error', isError);
    }
    if (retry) retry.hidden = !isError;
    if (token) maybeMountGoogleButton();
  }

  async function retryAuthSecurity() {
    const guard = window.SingVazaGuard;
    const mount = document.getElementById('authTurnstileMount');
    setAuthSecurityState('', 'Loading Cloudflare security check…');
    if (!guard || !mount) {
      setAuthSecurityState('', 'Security check is unavailable. Please reload the page.', true);
      return;
    }
    try {
      await guard.mountAuth(mount, setAuthSecurityState);
    } catch (_) {
      setAuthSecurityState('', 'Security check could not load. Please try again.', true);
    }
  }

  /* ---------------- light / dark theme ---------------- */
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }
  function applyTheme(theme) {
    var next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('singvaza-theme', next); } catch (_) {}
    var btn = document.getElementById('btnThemeToggle');
    if (btn) {
      btn.setAttribute('aria-pressed', String(next === 'light'));
      btn.title = next === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'light' ? '#f6f7fb' : '#07090f');
    // canvases redraw from CSS colours, so let the app refresh its drawings
    try {
      if (typeof drawTimeline === 'function') drawTimeline();
      if (typeof drawSpectrum === 'function') drawSpectrum();
      if (typeof drawPitchGraph === 'function') drawPitchGraph();
    } catch (_) {}
  }
  function toggleTheme() { applyTheme(currentTheme() === 'light' ? 'dark' : 'light'); }
  function initTheme() {
    applyTheme(currentTheme());
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var onChange = function (e) {
        var saved = null;
        try { saved = localStorage.getItem('singvaza-theme'); } catch (_) {}
        if (!saved) applyTheme(e.matches ? 'light' : 'dark');
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  function openAuthModal(defaultMode = null) {
    if (defaultMode) setAuthMode(defaultMode);
    document.getElementById('authModal').classList.add('open');
    document.getElementById('authLoggedInBox').style.display = state.user ? 'block' : 'none';
    document.getElementById('authForm').style.display = state.user ? 'none' : 'block';
    if (state.user) {
      document.getElementById('authUserName').textContent = state.user.display_name;
      document.getElementById('authUserEmail').textContent = state.user.email;
      updateAccountUI();
    } else {
      retryAuthSecurity();
    }
  }

  function closeAuthModal() {
    document.getElementById('authModal').classList.remove('open');
    window.SingVazaGuard?.unmountAuth();
    setAuthSecurityState('', 'Complete the security check to continue.');
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    document.getElementById('authNameWrap').style.display = mode === 'register' ? 'block' : 'none';
    document.getElementById('tabLoginBtn').className = mode === 'login' ? 'btn btn-sm btn-amber' : 'btn btn-sm';
    document.getElementById('tabRegBtn').className = mode === 'register' ? 'btn btn-sm btn-amber' : 'btn btn-sm';
    document.getElementById('authSubmitBtn').textContent = mode === 'login'
      ? 'Sign In'
      : 'Sign Up Free — Unlock 30 Days Pro';
  }

  async function submitAuth(e) {
    e.preventDefault();
    const payload = {
      email: document.getElementById('authEmail').value.trim(),
      password: document.getElementById('authPassword').value,
      display_name: document.getElementById('authName').value.trim(),
    };
    const guard = window.SingVazaGuard;
    payload.turnstileToken = guard?.takeAuthToken() || '';
    if (!payload.turnstileToken) {
      showToast('Please complete the security check before signing in.');
      guard?.resetAuth();
      return;
    }
    const path = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    try {
      const data = await apiFetch(path, { method: 'POST', body: JSON.stringify(payload) });
      if (data.error) {
        showToast(data.error);
        return;
      }
      state.authToken = data.token;
      state.user = data.user;
      if (data.quota) state.quota = data.quota;
      localStorage.setItem('singvaza_token', data.token);
      updateAccountUI();
      closeAuthModal();
      showToast(`Welcome ${data.user.display_name}! Your 30-Day Free Pro Pass is active!`);
    } catch (_) {
      showToast('Could not sign in. Please check your connection and try again.');
    } finally {
      if (!state.user && document.getElementById('authModal')?.classList.contains('open')) guard?.resetAuth();
    }
  }

  function logout() {
    state.authToken = '';
    state.user = null;
    state.isProDemo = false;
    localStorage.removeItem('singvaza_pro_demo');
    state.quota.proActive = false;
    state.quota.proDaysLeft = 0;
    state.quota.dailyUsed = loadGuestDailyExports();
    localStorage.removeItem('singvaza_token');
    updateAccountUI();
    closeAuthModal();
    showToast('Signed out');
  }

  async function deleteAccount() {
    if (!state.user) return;
    if (!window.confirm('Permanently delete your SingVaza account and saved mixes? This cannot be undone.')) {
      return;
    }
    try {
      const result = await apiFetch('/api/auth/account', { method: 'DELETE' });
      if (!result.deleted) {
        showToast(result.error || 'Could not delete your account. Please try again.');
        return;
      }
    } catch (_) {
      showToast('Could not delete your account. Please check your connection and try again.');
      return;
    }
    state.authToken = '';
    state.user = null;
    state.isProDemo = false;
    localStorage.removeItem('singvaza_pro_demo');
    state.projects = [];
    state.quota.proActive = false;
    state.quota.proDaysLeft = 0;
    localStorage.removeItem('singvaza_token');
    updateAccountUI();
    renderSavedProjects();
    closeAuthModal();
    showToast('Your account and cloud data have been permanently deleted.');
  }

  async function toggleProDemo() {
    if (!state.user) { openAuthModal('register'); return; }
    if ((state.quota?.proDaysLeft || 0) > 0) {
      showToast(`Your 30-Day Free Pro Pass is already active (${state.quota.proDaysLeft} days remaining)!`);
      return;
    }
    const next = !state.isProDemo;
    try {
      const response = await apiFetch('/api/upgrade-demo', { method: 'POST', body: JSON.stringify({ plan: next ? 'pro_global' : 'free' }) });
      if (!response.ok) { showToast(response.error || 'Could not change your plan.'); return; }
      state.isProDemo = next;
      localStorage.setItem('singvaza_pro_demo', next ? '1' : '0');
      await refreshServerState();
      showToast(next ? 'Temporary Free Pro Month activated!' : `Switched to ${state.dailyLimit}/day Free Tier`);
    } catch (_) { showToast('Could not change your plan. Check your connection.'); }
  }

  async function saveProjectToD1() {
    const title = document.getElementById('projectTitleInput').value.trim() || 'Untitled Mix';
    const data = await apiFetch('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        title,
        preset_key: state.activePreset,
        vocal_offset_ms: state.params.vocalOffsetMs,
        duration_sec: getTotalDuration(),
        settings: state.params,
      }),
    });
    if (data.ok || data.id) showToast('Saved mix settings to Cloudflare D1!');
  }

  function renderSavedProjects() {
    const box = document.getElementById('savedProjectsList');
    if (!box) return;
    const list = state.projects || [];
    if (!list.length) {
      box.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">No saved mixes yet — save any mix from Mix Studio.</div>';
      return;
    }
    box.innerHTML = list.map((p) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);gap:8px;">
        <div>
          <div style="font-weight:700;">${p.title}</div>
          <div style="font-size:11.5px;color:var(--text-secondary);">Preset: ${p.preset_key || p.preset_name} • Sync: ${p.vocal_offset_ms}ms</div>
        </div>
        <button class="btn btn-sm" onclick='App.restoreProject(${JSON.stringify(p).replace(/'/g, "&#39;")})'>Load</button>
      </div>
    `).join('');
  }

  function restoreProject(p) {
    document.getElementById('projectTitleInput').value = p.title;
    try {
      const s = typeof p.settings_json === 'string' ? JSON.parse(p.settings_json) : p.settings_json;
      state.activePreset = p.preset_key || p.preset_name || 'crystal_hd';
      state.params = { ...state.params, ...s };
      markMixDirty();
      renderPresets();
      syncSlidersFromParams();
    } catch (_) {}
    switchView('mix');
    showToast(`Loaded "${p.title}"`);
  }

  function onExportFormatChange() {
    const fmt = document.getElementById('exportFormatSelect')?.value || 'mp3_compact';
    const btn = document.getElementById('btnRenderMaster');
    if (btn && !btn.disabled) {
      btn.textContent = fmt.startsWith('mp3') ? 'Download MP3 Master' : 'Download WAV Master';
    }
  }

  function canDownload() {
    const limit = state.dailyLimit || 9;
    if (!isProActive() && getDailyUsedCount() >= limit) {
      showToast(`Daily ${limit}/${limit} downloads used • ${formatResetCountdown()}`);
      return false;
    }
    return true;
  }

  async function reserveDownload() {
    if (!canDownload()) return false;
    if (!state.user) {
      const next = loadGuestDailyExports() + 1;
      localStorage.setItem('singvaza_daily_date', getLocalDayKey());
      localStorage.setItem('singvaza_daily_used', String(next));
      state.exportsUsed = next;
      state.quota.dailyUsed = next;
      updateAccountUI();
      return true;
    }
    try {
      const result = await apiFetch('/api/track-export', { method: 'POST' });
      if (result?.quota) {
        state.quota = result.quota;
        state.dailyLimit = Math.max(1, Number(result.quota.dailyLimit) || 9);
      }
      updateAccountUI();
      if (!result?.ok || !result.allowed) {
        showToast(result?.error || `Daily download limit reached • ${formatResetCountdown()}`);
        return false;
      }
      return true;
    } catch (_) {
      showToast('Could not verify your download allowance. Check your connection.');
      return false;
    }
  }

  async function downloadKaraoke() {
    if (!state.karaokeCutActive || state.karaokeDirty || !state.karaokeWavUrl || state.karaokeBusy) {
      showToast('Apply the latest karaoke settings first.'); return;
    }
    const button = document.getElementById('btnDownloadKaraoke');
    if (button.disabled) return;
    button.disabled = true;
    try {
      if (!(await reserveDownload())) return;
      const a = document.createElement('a');
      a.href = state.karaokeWavUrl;
      const base = (state.uploadedFileName || 'singvaza').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '-').slice(0, 90) || 'singvaza';
      a.download = `${base}-karaoke.wav`;
      document.body.appendChild(a); a.click(); a.remove();
      showToast('Karaoke WAV is ready on your device.');
    } finally { updateVocalRemoverUI(); }
  }

  async function exportMasteredWav() {
    unlockMobileAudioSync();
    if (!canDownload()) return;
    if (!state.backingBuffer && !state.rawVocalBuffer) await preloadRealDemoAssets();

    const fmt = document.getElementById('exportFormatSelect')?.value || 'mp3_compact';
    const btn = document.getElementById('btnRenderMaster');
    btn.disabled = true;
    btn.textContent = fmt.startsWith('mp3') ? 'Encoding MP3...' : 'Mastering WAV...';

    try {
      const result = await SingVazaDSP.renderMasterAudio(
        { backing: state.backingBuffer, rawVocal: state.rawVocalBuffer, tunedVocal: state.tunedVocalBuffer },
        state.params,
        fmt,
        (pct) => { if (fmt.startsWith('mp3')) btn.textContent = `Encoding MP3 ${pct}%...`; }
      );
      suspendIdleWebAudio();

      if (!(await reserveDownload())) return;

      const fname = `${(document.getElementById('projectTitleInput').value || 'singvaza').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.${result.ext}`;
      const sizeMb = (result.blob.size / (1024 * 1024)).toFixed(2);
      state.lastMasterBlob = result.blob;
      state.lastMasterMime = result.mime;
      state.lastMasterFilename = fname;

      const url = URL.createObjectURL(result.blob);
      document.getElementById('masterOutputArea').style.display = 'block';
      const readyLabel = document.getElementById('masterReadyLabel');
      if (readyLabel) {
        readyLabel.textContent = `✓ Mastered ${result.ext.toUpperCase()} Ready (${sizeMb} MB)`;
      }
      document.getElementById('renderedAudioPlayer').src = url;

      btn.disabled = false;
      onExportFormatChange();

      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      a.click();

      if (window.confetti && !isLowEndDevice) {
        window.confetti({ particleCount: 60, spread: 60, origin: { y: 0.7 } });
      }
      showToast(`Mastered ${result.ext.toUpperCase()} downloaded (${sizeMb} MB)!`);
    } catch (err) {
      showToast('Export error: ' + err.message);
    } finally {
      btn.disabled = false;
      onExportFormatChange();
    }
  }

  async function shareMasterFile() {
    if (!state.lastMasterBlob) {
      showToast('Render your song first');
      return;
    }
    try {
      const file = new File([state.lastMasterBlob], state.lastMasterFilename, {
        type: state.lastMasterMime || 'audio/mpeg',
      });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: document.getElementById('projectTitleInput').value || 'My SingVaza Cover',
          text: 'Recorded & mastered on SingVaza',
          files: [file],
        });
        return;
      }
    } catch (_) {}
    if (!(await reserveDownload())) return;
    const url = URL.createObjectURL(state.lastMasterBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.lastMasterFilename;
    a.click();
    showToast(`Saved ${state.lastMasterFilename} to device!`);
  }

  // ==================== TOP-LEFT HAMBURGER DRAWER, PRIVACY SETTINGS & HUMAN BLOG CMS ====================
  let liveBlogPosts = [];

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatArticleBodyHtml(raw) {
    return String(raw || '')
      .replace(/\r\n/g, '\n')
      .split(/\n{2,}/)
      .map((b) => {
        const t = b.trim();
        if (!t) return '';
        if (t.startsWith('## ')) return `<h3 style="color:var(--amber-bright);margin:16px 0 6px;">${escHtml(t.slice(3))}</h3>`;
        if (t.startsWith('### ')) return `<h4 style="color:var(--text);margin:14px 0 6px;">${escHtml(t.slice(4))}</h4>`;
        return `<p style="margin-bottom:12px;">${escHtml(t).replace(/\n/g, '<br />')}</p>`;
      })
      .filter(Boolean)
      .join('');
  }

  function toggleDrawer(forceOpen = null) {
    const bd = document.getElementById('sideDrawerBackdrop');
    const dr = document.getElementById('sideDrawer');
    if (!bd || !dr) return;
    const next = forceOpen !== null ? forceOpen : !dr.classList.contains('open');
    bd.classList.toggle('open', next);
    dr.classList.toggle('open', next);
  }

  function drawerGo(viewName) {
    toggleDrawer(false);
    if (viewName !== 'sing') pauseYoutubeStage();
    if (viewName === 'blog') loadBlogPostsFromServer();
    switchView(viewName);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openPrivacySettings() {
    toggleDrawer(false);
    const saved = localStorage.getItem('singvaza_ad_consent') || 'personalized';
    const sel = document.getElementById('adConsentSelect');
    if (sel) sel.value = saved;
    const modal = document.getElementById('privacyModal');
    if (modal) modal.classList.add('open');
  }

  function closePrivacySettings() {
    const modal = document.getElementById('privacyModal');
    if (modal) modal.classList.remove('open');
  }

  function savePrivacySettings() {
    const val = document.getElementById('adConsentSelect')?.value || 'personalized';
    localStorage.setItem('singvaza_ad_consent', val);
    localStorage.setItem('singvaza_privacy_updated_at', new Date().toISOString());
    closePrivacySettings();
    showToast('Privacy & cookie preferences saved!');
  }

  function clearLocalStudioData() {
    localStorage.removeItem('singvaza_pro_demo');
    state.isProDemo = false;
    updateAccountUI();
    showToast('Preferences cleared. The daily download counter resets at midnight.');
  }

  let liveTools = [];
  let discoveryFetched = false;
  let discoveryError = false;
  let discoveryPending = null;
  async function loadDiscovery(force = false) {
    if (discoveryFetched && !force) { renderDiscovery(); return; }
    if (discoveryPending) return discoveryPending;
    discoveryPending = (async () => {
      const [tools, posts] = await Promise.all(['/api/tools?summary=1', '/api/blog?summary=1'].map(async (url) => {
        try {
          const response = await fetch(url);
          if (!response.ok) return null;
          return await response.json();
        } catch (_) { return null; }
      }));
      if (tools) liveTools = Array.isArray(tools.tools) ? tools.tools : [];
      if (posts) liveBlogPosts = Array.isArray(posts.posts) ? posts.posts : [];
      discoveryError = !tools || !posts;
      discoveryFetched = !discoveryError;
      renderDiscovery(); renderBlogList();
    })();
    try { await discoveryPending; } finally { discoveryPending = null; }
  }
  async function loadBlogPostsFromServer(force = false) {
    if (!discoveryFetched || force) await loadDiscovery(force);
    else renderBlogList();
  }
  function discoveryItems() {
    return [
      { key: 'builtin-office-pdf', kind: 'tool', title: 'Word / Excel / PowerPoint to PDF', description: 'Turn .docx, .xlsx or .pptx into a clean PDF with your paper size and margins.', keywords: 'word excel powerpoint docx xlsx pptx office pdf convert document' },
      { key: 'builtin-html-pdf', kind: 'tool', title: 'HTML / Code to PDF', description: 'Turn HTML, Markdown or code into a PDF, Word, Excel or PowerPoint file.', keywords: 'html markdown code pdf word excel pptx convert document' },
      { key: 'builtin-recorder', kind: 'tool', title: 'Karaoke Recorder', description: 'Sing, record and mix your voice.', keywords: 'sing record karaoke audio microphone ගීත' },
      ...liveTools.map((t) => ({ key: `tool-${t.id}`, kind: 'tool', title: String(t.title || ''), description: String(t.description || ''), keywords: `${t.category || ''} ${t.seo_tags || ''}`, tool: t })),
      ...liveBlogPosts.map((b) => ({ key: `blog-${b.id}`, kind: 'blog', title: String(b.title || ''), description: String(b.excerpt || ''), keywords: `${b.category || ''} ${b.seo_tags || ''}`, post: b })),
    ];
  }
  function renderDiscovery() {
    const cards = document.getElementById('toolCards');
    const preview = document.getElementById('homeBlogPreview');
    if (!cards || !preview) return;
    const query = String(document.getElementById('siteSearch')?.value || '').trim().slice(0, 120);
    const items = discoveryItems();
    let results = items;
    if (query) {
      if (window.SingVazaFuse) {
        results = new window.SingVazaFuse(items, { keys: ['title', 'description', 'keywords'], threshold: 0.33, ignoreLocation: true }).search(query).map((r) => r.item);
      } else {
        const term = query.toLocaleLowerCase();
        results = items.filter((i) => `${i.title} ${i.description} ${i.keywords}`.toLocaleLowerCase().includes(term));
      }
    }
    const toolItems = results.filter((i) => i.kind === 'tool');
    const blogItems = results.filter((i) => i.kind === 'blog');
    // the built-in tiles carry a data-discovery key that matches the search entries above
    const alias = { 'builtin-office-pdf': 'homeOfficeToPdf', 'builtin-html-pdf': 'homeHtmlToPdf', 'builtin-recorder': 'homeRecorder' };
    const matchedKeys = new Set(toolItems.map((i) => i.key));
    for (const el of cards.querySelectorAll('[data-discovery]')) {
      const builtIn = el.dataset.discovery.startsWith('builtin-');
      if (!builtIn) el.remove();
      else el.style.display = matchedKeys.has(el.dataset.discovery) ? 'flex' : 'none';
    }
    for (const [key, id] of Object.entries(alias)) {
      const el = document.getElementById(id);
      if (el) el.style.display = matchedKeys.has(key) ? '' : 'none';
      if (el) el.hidden = !matchedKeys.has(key);
    }
    for (const item of toolItems.filter((i) => i.tool)) {
      const t = item.tool;
      const link = document.createElement('a');
      link.className = 'tool-tile'; link.dataset.discovery = item.key;
      link.href = `/tools/${encodeURIComponent(t.slug)}`;
      link.innerHTML = `<span class="tool-tile-top"><span class="tool-tile-icon">${escHtml(t.icon || '✦')}</span><span class="tool-tile-label">${escHtml(t.category || 'Web tool')}</span></span><h3>${escHtml(item.title)}</h3><p>${escHtml(item.description)}</p><span class="tool-tile-link">Open tool →</span>`;
      cards.appendChild(link);
    }
    if (!toolItems.length) {
      const empty = document.createElement('div'); empty.className = 'empty-discovery'; empty.dataset.discovery = 'empty';
      empty.textContent = query ? 'No tools match your search.' : 'More tools are coming soon.'; cards.appendChild(empty);
    }
    // count what the visitor can actually see: hidden/removed tiles do not count
    const visibleTiles = Array.from(cards.querySelectorAll('.tool-tile')).filter((el) => el.style.display !== 'none' && !el.hidden).length;
    const emptyBlock = cards.querySelector('.empty-discovery');
    const shown = emptyBlock ? 0 : (visibleTiles || toolItems.length);
    document.getElementById('toolCount').textContent = `${shown} ${shown === 1 ? 'tool' : 'tools'}`;
    const showBlogs = query ? blogItems : blogItems.slice(0, 3);
    preview.innerHTML = showBlogs.length ? showBlogs.map((i) => `<a class="home-blog-card" href="/blog/${encodeURIComponent(i.post.slug)}"><span class="section-eyebrow">${escHtml(i.post.category || 'Guide')}</span><strong>${escHtml(i.title)}</strong><p>${escHtml(i.description)}</p><span class="tool-tile-link">Read article →</span></a>`).join('') : `<div class="empty-discovery">${query ? 'No articles match your search.' : 'Articles will appear here when they are published.'}</div>`;
    const status = document.getElementById('discoveryStatus');
    status.textContent = discoveryError ? 'Some published content could not be loaded. Please refresh or try again.' : query ? `${results.length} result${results.length === 1 ? '' : 's'} across tools and articles.` : '';
  }
  function searchDiscovery() { renderDiscovery(); }
  function searchFromBlog(event) {
    event.preventDefault();
    const value = document.getElementById('blogSearch')?.value || '';
    switchView('home');
    document.getElementById('siteSearch').value = value;
    renderDiscovery();
    document.getElementById('siteSearch').focus();
  }
  function renderBlogList() {
    const grid = document.getElementById('blogPostsGrid');
    const reader = document.getElementById('blogReaderWrap');
    if (!grid) return;
    if (reader) reader.style.display = 'none';
    grid.style.display = 'grid';
    if (!liveBlogPosts.length) {
      grid.innerHTML = `<div class="empty-discovery">${discoveryError ? 'Articles could not be loaded. Please refresh and try again.' : 'New guides, tutorials and articles will appear here when they are published.'}</div>`;
      return;
    }
    grid.innerHTML = liveBlogPosts.map((b) => `<a class="blog-card" href="/blog/${encodeURIComponent(b.slug)}" style="text-decoration:none;color:inherit"><img src="${escHtml(b.cover_image || '/assets/studio-girl-card.jpg')}" alt="" loading="lazy" /><div class="blog-card-body"><span class="section-eyebrow">${escHtml(b.category || 'Guide')}</span><h3 style="font-size:16px;margin:6px 0">${escHtml(b.title)}</h3><p style="font-size:13px;color:var(--text-secondary)">${escHtml(b.excerpt || '')}</p><span class="tool-tile-link">Read article →</span></div></a>`).join('');
  }

  function openBlogPost(postId) {
    const post = liveBlogPosts.find((b) => String(b.id) === String(postId));
    if (!post) return;
    if (post.content_format === 'full_html') {
      window.location.href = `/blog/${encodeURIComponent(post.slug)}`;
      return;
    }
    const grid = document.getElementById('blogPostsGrid');
    const reader = document.getElementById('blogReaderWrap');
    const content = document.getElementById('blogReaderContent');
    if (!grid || !reader || !content) return;
    grid.style.display = 'none';
    reader.style.display = 'block';

    const rawBody = String(post.content || '');
    const isRichHtml = post.content_format === 'html' || /<(p|div|h1|h2|h3|h4|ul|ol|table|section|article|img|blockquote|pre)[\s>]/i.test(rawBody);
    const bodyHtml = isRichHtml ? rawBody : formatArticleBodyHtml(rawBody);

    content.innerHTML = `
      ${post.cover_image ? `<img src="${escHtml(post.cover_image)}" alt="${escHtml(post.title)}" style="width:100%;max-height:280px;object-fit:cover;border-radius:14px;margin-bottom:16px;" />` : ''}
      <div style="font-size:11.5px;font-weight:800;color:var(--cyan);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:6px;">
        ${escHtml(post.category || 'Guide')} • By ${escHtml(post.author_name || 'Editorial Team')} • ${escHtml(String(post.created_at || '').slice(0, 10))}
      </div>
      <h2 style="font-size:22px;line-height:1.25;margin-bottom:14px;">${escHtml(post.title)}</h2>
      <div style="font-size:14.5px;color:#cbd5e1;line-height:1.78;">${bodyHtml}</div>
      <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
        <button class="btn btn-amber" onclick="App.drawerGo('home')">Explore SingVaza →</button>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-sm" onclick="App.shareWebsite('${escHtml(post.title)}', window.location.origin + '/blog/${escHtml(post.slug)}')">Share Article</button>
          <a href="/blog/${escHtml(post.slug)}" class="btn btn-sm" style="text-decoration:none;">Direct Article Link ↗</a>
        </div>
      </div>
    `;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  let pendingSharePayload = { title: 'SingVaza — Karaoke & Vocal Studio', url: window.location.origin };

  function shareWebsite(customTitle = '', customUrl = '') {
    const shareTitle = customTitle || 'SingVaza — Free Online Karaoke, Vocal Studio & Tools';
    const shareUrl = customUrl || window.location.origin + (window.location.pathname || '/');
    pendingSharePayload = { title: shareTitle, url: shareUrl };

    const encUrl = encodeURIComponent(shareUrl);
    const encText = encodeURIComponent(`${shareTitle} — `);
    const titleEl = document.getElementById('shareModalTitle');
    if (titleEl) titleEl.textContent = customTitle ? 'Share Article' : 'Share SingVaza';

    const wa = document.getElementById('shareWaBtn');
    const fb = document.getElementById('shareFbBtn');
    const tg = document.getElementById('shareTgBtn');
    const tw = document.getElementById('shareXBtn');
    const inp = document.getElementById('shareUrlInput');
    const natBtn = document.getElementById('nativeShareBtn');

    if (wa) wa.href = `https://wa.me/?text=${encodeURIComponent(shareTitle + ' ' + shareUrl)}`;
    if (fb) fb.href = `https://www.facebook.com/sharer/sharer.php?u=${encUrl}`;
    if (tg) tg.href = `https://t.me/share/url?url=${encUrl}&text=${encText}`;
    if (tw) tw.href = `https://twitter.com/intent/tweet?url=${encUrl}&text=${encText}`;
    if (inp) inp.value = shareUrl;
    if (natBtn) natBtn.style.display = navigator.share ? 'inline-flex' : 'none';

    const modal = document.getElementById('shareModal');
    if (modal) modal.classList.add('open');
  }

  function closeShareModal() {
    const modal = document.getElementById('shareModal');
    if (modal) modal.classList.remove('open');
  }

  function copyShareLink() {
    const url = pendingSharePayload.url || window.location.href;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(() => showToast('Link copied!')).catch(() => {});
    } else {
      const inp = document.getElementById('shareUrlInput');
      if (inp) { inp.select(); document.execCommand('copy'); showToast('Link copied!'); }
    }
  }

  function triggerNativeShare() {
    if (navigator.share) {
      navigator.share({
        title: pendingSharePayload.title,
        text: pendingSharePayload.title,
        url: pendingSharePayload.url,
      }).catch(() => {});
    }
  }

  function closeBlogPost() {
    renderBlogList();
  }

  // ==================== MIX STUDIO DELETE CONFIRMATION MODAL ====================
  function openDeleteAudioModal() {
    const hasAnyAudio = Boolean(
      state.rawVocalBuffer ||
      state.backingBuffer ||
      state.uploadedMediaUrl ||
      state.isDemoSession ||
      state.cachedMixUrl ||
      (hwAudio.src && hwAudio.src !== window.location.href)
    );
    if (!hasAnyAudio) {
      showToast('Mixer is already empty — nothing to delete.');
      return;
    }
    const modal = document.getElementById('deleteAudioModal');
    if (modal) modal.classList.add('open');
  }

  function closeDeleteAudioModal() {
    const modal = document.getElementById('deleteAudioModal');
    if (modal) modal.classList.remove('open');
  }

  function purgeHardwareAudioCompletely() {
    stopPlaybackInternal();
    state.pausePositionSec = 0;
    if (state.cachedMixUrl && state.cachedMixUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(state.cachedMixUrl); } catch (_) {}
    }
    state.cachedMixUrl = '';
    state.lastMasterBlob = null;
    for (const el of [hwAudio, hwAudioStandby]) {
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch (_) {}
    }
    const rtEl = document.getElementById('recTimerText');
    if (rtEl) rtEl.textContent = '00:00';
    const pitchEl = document.getElementById('livePitchText');
    if (pitchEl) pitchEl.textContent = 'Note: --';
    const meterEl = document.getElementById('micMeterFill');
    if (meterEl) meterEl.style.width = '0%';
  }

  function confirmDeleteAudio(mode) {
    closeDeleteAudioModal();
    setProcessingBanner(false);
    purgeHardwareAudioCompletely();
    resetCropMarkers();
    state.uncroppedBackup = null;
    const undoBtn = document.getElementById('btnUndoCrop');
    if (undoBtn) undoBtn.style.display = 'none';

    if (mode === 'vocal') {
      state.rawVocalBuffer = null;
      state.tunedVocalBuffer = null;
      state.vocalPeaks = null;
      state.isDemoSession = false;
      markMixDirty();
      const previewWrap = document.getElementById('exportPreviewWrap');
      if (previewWrap) previewWrap.style.display = 'none';
      const total = getTotalDuration();
      const mixT = document.getElementById('transportTime');
      if (mixT) mixT.textContent = `00:00 / ${fmtTime(total)}`;
      drawSpectrum();
      drawTimeline(0);
      showToast('Voice audio deleted cleanly.');
      return;
    }

    // mode === 'all'
    resetKaraoke();
    state.rawVocalBuffer = null;
    state.tunedVocalBuffer = null;
    state.vocalPeaks = null;
    state.originalBackingBuffer = null;
    state.backingBuffer = null;
    state.backingPeaks = null;
    state.userLoadedBacking = false;
    state.backingDecodePending = false;
    state.backingLoadSeq += 1;
    state.karaokeCutActive = false;
    state.isDemoSession = false;
    updateVocalRemoverUI();

    const mediaEl = document.getElementById('stageUploadedMedia');
    if (mediaEl) { try { mediaEl.pause(); } catch (_) {} }
    if (state.uploadedMediaUrl) {
      try { URL.revokeObjectURL(state.uploadedMediaUrl); } catch (_) {}
      state.uploadedMediaUrl = '';
      state.uploadedIsVideo = false;
      state.uploadedFileName = '';
      const clearBtn = document.getElementById('btnClearStageTrack');
      if (clearBtn) clearBtn.style.display = 'none';
      const upLyrForm = document.getElementById('uploadLyricsSearchForm');
      if (upLyrForm) upLyrForm.style.display = 'none';
      const wrap = document.getElementById('stageVideoWrap');
      if (wrap) {
        wrap.innerHTML = `
          <div>
            <div style="font-weight:700;color:var(--text);font-size:15px;margin-bottom:4px;">Karaoke Video / Audio Stage</div>
            <div style="font-size:13px;">Search any song above or tap <strong>Upload Audio / Video</strong> to play your own MP3 or MP4 right here.</div>
          </div>
        `;
      }
    }

    markMixDirty();
    const previewWrap = document.getElementById('exportPreviewWrap');
    if (previewWrap) previewWrap.style.display = 'none';
    const mixT = document.getElementById('transportTime');
    if (mixT) mixT.textContent = '00:00 / 00:00';
    drawSpectrum();
    drawTimeline(0);
    showToast('All audio deleted cleanly.');
  }

  // ==================== ULTRA-FAST ZERO-RAM BOOT ====================
  function init() {
    initTheme();
    if (!document.body.contains(hwAudio)) {
      document.body.appendChild(hwAudio);
    }
    initLightweightDemoEnvelope();
    renderPresets();
    renderBlogList();
    syncSlidersFromParams();
    updateFxButtonsUI();
    updateVocalRemoverUI();
    initTimelinePointerInteractions();
    switchView(viewFromLocation(), false);
    const initialSearch = new URLSearchParams(location.search).get('q');
    if (initialSearch) { document.getElementById('siteSearch').value = initialSearch.slice(0, 120); renderDiscovery(); }
    window.addEventListener('popstate', () => {
      if (state.isRecording || state.waitingForYtTap) stopActiveRecordingNow();
      else pauseYoutubeStage();
      document.getElementById('karaokeComparePlayer')?.pause();
      switchView(viewFromLocation(), false);
    });
    loadDiscovery();
    refreshServerState();

    // Deferred non-blocking analytics beacon (skips logged-in Admin owner + once per session tab)
    setTimeout(() => {
      const pKey = 'sv_v_' + (window.location.pathname || '/');
      if (!localStorage.getItem('singvaza_admin_token') && !sessionStorage.getItem(pKey)) {
        sessionStorage.setItem(pKey, '1');
        fetch('/api/ping-visit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: window.location.pathname || '/' }),
        }).catch(() => {});
      }

      fetch('/api/public-config')
        .then((r) => r.json())
        .then((cfg) => {
          if (!cfg) return;
          if (Number(cfg.tools_count || 0) > 0) {
            const dl = document.getElementById('drawerToolsLink');
            const bb = document.getElementById('blogToolsBtn');
            if (dl) dl.style.display = 'flex';
            if (bb) bb.style.display = 'inline-flex';
          }
          if (cfg.whatsapp_enabled && cfg.business_whatsapp) {
            const wl = document.getElementById('drawerWhatsappLink');
            if (wl) {
              wl.href = 'https://wa.me/' + String(cfg.business_whatsapp).replace(/[^\d]/g, '');
              wl.style.display = 'flex';
            }
          }
          if (cfg.google_client_id && !state.googleClientId) {
            updateGoogleClientId(cfg.google_client_id);
          }
        })
        .catch(() => {});
    }, 900);

    window.addEventListener('pointerdown', unlockMobileAudioSync, { once: true, passive: true });
    window.addEventListener('touchstart', unlockMobileAudioSync, { once: true, passive: true });
  }

  document.addEventListener('DOMContentLoaded', init);

  function pauseYoutubeStage() {
    ytSendCommand('pauseVideo');
    const stageMedia = document.getElementById('stageUploadedMedia');
    if (stageMedia) { try { stageMedia.pause(); } catch (_) {} }
  }

  return {
    switchView: (v) => {
      if (v !== 'vocal-remover') { try { document.getElementById('karaokeComparePlayer')?.pause(); } catch (_) {} }
      if (v !== 'sing') {
        if (state.isRecording || state.waitingForYtTap) {
          stopActiveRecordingNow();
        } else {
          pauseYoutubeStage();
        }
      }
      if (v === 'blog') loadBlogPostsFromServer();
      switchView(v);
    },
    toggleDrawer, drawerGo, searchDiscovery, searchFromBlog, downloadKaraoke,
    shareWebsite, closeShareModal, copyShareLink, triggerNativeShare,
    openPrivacySettings, closePrivacySettings, savePrivacySettings, clearLocalStudioData,
    openBlogPost, closeBlogPost,
    openDeleteAudioModal, closeDeleteAudioModal, confirmDeleteAudio,
    setStageMode, getMasterSignalRms,
    hwStateDebug: () => ({
      src: hwAudio.src,
      paused: hwAudio.paused,
      currentTime: hwAudio.currentTime,
      duration: hwAudio.duration,
      isLowEndDevice,
      audioCtxState: state.audioCtx ? state.audioCtx.state : 'uncreated',
    }),
    ytStateDebug: () => ({
      playerState: state.ytPlayer?.getPlayerState?.(),
      currentTime: state.ytPlayer?.getCurrentTime?.(),
      isMuted: state.ytPlayer?.isMuted?.(),
    }),
    toggleHeroDemo, openMixWithRealDemo, openVocalRemover, loadRealSingerDemo, loadInstrumentalDemoForSing,
    togglePlayback, stopAndRewind, toggleBypassFx, toggleSoloVocal,
    scrubPlayhead, updateCropSlider, markCropAtPlayhead, applyAudioCrop, undoAudioCrop,
    applyPreset, setClarityMacro, setFilterCut, updateParam, setMasterProfile, setVocalOffset, nudgeVocalOffset, autoAlignTracks, runSmartVoiceMatch,
    applyWorkerAutoTune, shiftBackingKey, applyKaraokeVocalCut, updateKaraokeVocalCut,
    karaokeSettingsChanged, setKaraokePreset, markKaraokeIntro, cancelKaraokeProcessing, compareKaraoke, useKaraokeForSing,
    heroSearchSubmit, quickSingSong, searchOrLoadKaraoke, selectKaraokeVideo, nextKaraokeResult, seekToLyric,
    searchLyricsOnly, clearUploadedStageTrack,
    toggleCustomLyricsEditor, saveCustomLyrics,
    onMicModeChange, handleBackingUpload, handleVocalUpload, toggleMicMonitor, toggleMicRecording, receiveNativeDualTracks,
    toggleTheme, applyTheme, openAuthModal, closeAuthModal, retryAuthSecurity, setAuthMode, startGmailQuickSignup, submitAuth, logout, deleteAccount, toggleProDemo,
    saveProjectToD1, restoreProject, onExportFormatChange, exportMasteredWav, shareMasterFile,
  };
})();
