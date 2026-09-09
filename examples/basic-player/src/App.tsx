import { useEffect, useRef, useState } from "react";
import {
  AUDIO_LEVEL_SILENCE_DB,
  H422Player,
  formatTimecodeFrame,
  isWaitingPlayerState,
  type AudioChannelLevel,
  type AudioLevels,
  type H422PlayerHandle,
  type MxfMediaInfo,
  type PlayerInfo,
  type PlayerState,
  type PlaybackMode,
  type VideoRenderMode,
  type PlayerDiagnostics,
} from "@openmxf/h422-player";

const stateLabels: Record<PlayerState, string> = {
  idle: "待機中",
  loading: "読み込み中",
  ready: "再生準備完了",
  seeking: "シーク中",
  playing: "再生中",
  paused: "一時停止中",
  ended: "再生終了",
  error: "エラー",
  buffering: "バッファリング中",
};

/** Meter scale. -60 dBFS is the bottom of the bar; the library floors its values lower than that. */
const METER_FLOOR_DB = -60;

const meterHeight = (db: number) => `${Math.round(Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB)) * 100)}%`;

/** Peak colouring is the demo's choice, not the library's: green up to -12, amber, red near clip. */
const meterTone = (db: number) => (db >= -3 ? "clip" : db >= -12 ? "warn" : "ok");

function LevelMeter({ label, level }: { label: string; level?: AudioChannelLevel }) {
  const peakDb = level?.peakDb ?? AUDIO_LEVEL_SILENCE_DB, rmsDb = level?.rmsDb ?? AUDIO_LEVEL_SILENCE_DB;
  return (
    <div className="level-meter">
      <div className="level-track" role="meter" aria-label={`${label} 音声レベル`} aria-valuemin={METER_FLOOR_DB} aria-valuemax={0} aria-valuenow={Math.max(METER_FLOOR_DB, Math.round(peakDb))}>
        <div className={`level-fill level-${meterTone(rmsDb)}`} style={{ height: meterHeight(rmsDb) }} />
        <div className={`level-peak level-${meterTone(peakDb)}`} style={{ bottom: meterHeight(peakDb) }} />
      </div>
      <span className="level-label">{label}</span>
      <span className="level-value">{peakDb <= METER_FLOOR_DB ? "-∞" : peakDb.toFixed(0)}</span>
    </div>
  );
}

const obtained = (value: string | number | undefined) => value ?? "未取得";

const formatTime = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor(safeSeconds / 60) % 60;
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const milliseconds = Math.floor((safeSeconds % 1) * 1000);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${wholeSeconds.toString().padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
};

const formatMB = (bytes: number | undefined) => bytes === undefined ? "-" : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
const formatMs = (ms: number | undefined) => ms === undefined ? "-" : `${(ms / 1000).toFixed(1)} s`;

/** A snapshot the measurement panel diffs against, so its counters read "since this button was pressed". */
interface MeasurementBaseline {
  atMs: number;
  bufferingEventCount: number;
  bufferingTotalMs: number;
}

export function App() {
  const playerRef = useRef<H422PlayerHandle>(null);
  const [file, setFile] = useState<File>();
  const [playerState, setPlayerState] = useState<PlayerState>("idle");
  const [error, setError] = useState("");
  const [info, setInfo] = useState<PlayerInfo>();
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaInfo, setMediaInfo] = useState<MxfMediaInfo>();
  const [timecode, setTimecode] = useState<string | null>(null);
  const [timecodeInput, setTimecodeInput] = useState("");
  const [timecodeError, setTimecodeError] = useState("");
  const [rate, setRate] = useState(1);
  const [audioLevels, setAudioLevels] = useState<AudioLevels>();
  const [meterEnabled, setMeterEnabled] = useState(false);

  const [buffering, setBuffering] = useState(false);
  const [mode,setMode]=useState<PlaybackMode>("streaming");
  const [videoRenderMode,setVideoRenderMode]=useState<VideoRenderMode>("yuv-webgl");
  const [diagnostics,setDiagnostics]=useState<PlayerDiagnostics>();
  const [measurementBaseline, setMeasurementBaseline] = useState<MeasurementBaseline>();
  const [measurementNow, setMeasurementNow] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const selectedStartTimecode = mediaInfo?.selectedTimecode
    ? formatTimecodeFrame(mediaInfo.selectedTimecode.startFrame, mediaInfo.selectedTimecode.roundedTimecodeBase, mediaInfo.selectedTimecode.dropFrame)
    : undefined;

  const selectFile = (nextFile?: File) => {
    if (nextFile) console.info("[H422Player example] MXF selected", { name: nextFile.name, size: nextFile.size, type: nextFile.type || "(empty)", lastModified: new Date(nextFile.lastModified).toISOString(), mode });
    else console.info("[H422Player example] MXF selection cleared", { mode });
    setFile(nextFile);
    setError("");
    setInfo(undefined);
    setCurrentTime(0);
    setMediaInfo(undefined);
    setTimecode(null);
    setPlayerState(nextFile ? "loading" : "idle");
    setBuffering(false);
    setAudioLevels(undefined);
    setMeasurementBaseline(undefined);
    setCopyStatus("");
  };

  // Diagnostics only update while the engine has work to do (a fill, a tick), so the elapsed clock
  // gets its own tick to keep counting while paused or between chunks.
  useEffect(() => {
    if (!measurementBaseline) return;
    const timer = window.setInterval(() => setMeasurementNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [measurementBaseline]);

  const startMeasurement = () => {
    const atMs = Date.now();
    setMeasurementBaseline({ atMs, bufferingEventCount: diagnostics?.bufferingEventCount ?? 0, bufferingTotalMs: diagnostics?.bufferingTotalMs ?? 0 });
    setMeasurementNow(atMs);
  };

  const copyDiagnostics = async () => {
    const payload = { capturedAt: new Date().toISOString(), mode, videoRenderMode, diagnostics, measurement: measurementBaseline && diagnostics ? {
      elapsedSeconds: Number(((measurementNow - measurementBaseline.atMs) / 1000).toFixed(1)),
      bufferingEventCount: (diagnostics.bufferingEventCount ?? 0) - measurementBaseline.bufferingEventCount,
      bufferingTotalMs: (diagnostics.bufferingTotalMs ?? 0) - measurementBaseline.bufferingTotalMs,
    } : undefined };
    console.info("[H422Player example] diagnostics snapshot", payload);
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopyStatus("コピーしました（コンソールにも出力しました）");
    } catch {
      setCopyStatus("クリップボードにコピーできませんでした。コンソールに出力しました");
    }
  };

  const play = async () => {
    try {
      setError("");
      await playerRef.current?.play();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const stop = async () => {
    playerRef.current?.pause();
    await playerRef.current?.seek(0);
    setCurrentTime(0);
  };

  const seek = (seconds: number) => {
    setCurrentTime(seconds);
    void playerRef.current?.seek(seconds);
  };

  const jumpTimecode = async () => {
    setTimecodeError("");
    try { await playerRef.current?.seekTimecode(timecodeInput); }
    catch (reason) {
      const message=reason instanceof Error?reason.message:String(reason);
      setTimecodeError(message==="out-of-range"?"指定したタイムコードは素材範囲外です。":message==="timecode-track-unavailable"?"Timecode Trackがないためタイムコード指定ジャンプは利用できません。":"入力形式が正しくありません。HH:MM:SS:FF（DFはHH:MM:SS;FF）で入力してください。");
    }
  };

  // The library composes the waiting states; deciding what to disable and what to spin is the host's job.
  const waiting = isWaitingPlayerState(playerState);
  const transportBusy = !info || waiting || playerState === "error";

  return (
    <main>
      <header className="app-header">
        <span className="app-title">OpenMxfH422Player</span>
        <span className="app-version" title={`git commit ${__GIT_COMMIT__}`}>v{__APP_VERSION__} ({__GIT_COMMIT__})</span>
      </header>
      <section className="panel file-panel">
        <label className="mode-control">再生方式
          <select value={mode} onChange={event=>{const nextMode=event.target.value as PlaybackMode;console.info("[H422Player example] playback mode changed", { from: mode, to: nextMode });setBuffering(false);setMode(nextMode);}}>
            <option value="streaming">Streaming</option>
            <option value="legacy">Legacy</option>
          </select>
        </label>
        <label className="mode-control">映像描画
          <select value={videoRenderMode} onChange={event=>{const next=event.target.value as VideoRenderMode;console.info("[H422Player example] video render mode changed",{from:videoRenderMode,to:next});setVideoRenderMode(next);}}>
            <option value="rgba">RGBA（CPU変換）</option>
            <option value="yuv-webgl">YUV→WebGL（GPU変換）</option>
          </select>
        </label>
        <label className="file-picker">
          <span>MXF選択</span>
          <input type="file" accept=".mxf,application/mxf" onChange={(event) => selectFile(event.target.files?.[0])} />
        </label>
        <span className="filename" title={file?.name}>{file?.name ?? "未選択"}</span>
        <span className="mode-note" title={mode === "streaming" ? "必要な区間を部分読み込みします。対応外の音声形式では映像のみ再生します。" : "ファイル全体を読み込む互換モードです。"}>{mode === "streaming" ? "部分読み込み" : "互換モード"}</span>
      </section>

      <section className="viewer" aria-label="MXF player">
        {file ? (
          <div className="viewer-stage">
            <H422Player
              key={`${file.name}-${file.lastModified}-${mode}-${videoRenderMode}`}
              ref={playerRef}
              className="player-surface"
              src={file}
              controls={false}
              libavBase="/libav"
              mode={mode}
              videoRenderMode={videoRenderMode}
              enableAudioLevels={meterEnabled}
              onDiagnostics={setDiagnostics}
              onBufferingChange={setBuffering}
              onReady={setInfo}
              onMediaInfo={setMediaInfo}
              onTimecode={setTimecode}
              onTimeUpdate={setCurrentTime}
              onStateChange={setPlayerState}
              onPlaybackRateChange={setRate}
              onAudioLevelUpdate={setAudioLevels}
              onError={(nextError) => setError(nextError.message)}
            />
            {meterEnabled && (
              <div className="level-meters" aria-label="音声レベルメーター">
                <LevelMeter label="1ch" level={audioLevels?.channels[0]} />
                <LevelMeter label="2ch" level={audioLevels?.channels[1]} />
              </div>
            )}
            {waiting && (
              <div className="loading-overlay" role="status">
                <span className="spinner" aria-hidden="true" />
                <span>{stateLabels[playerState]}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="empty-state">MXFを選択すると、ここに映像が表示されます</div>
        )}
      </section>

      <section className="panel controls" aria-label="Playback controls">
        <div className="timecode-row">
          <div className="current-timecode">
            <span className="control-label">現在位置</span>
            <strong className="timecode-display">{timecode ?? "Timecode Trackなし"}</strong>
          </div>
          <div className="timecode-jump">
            <label htmlFor="timecode-input" className="control-label">ジャンプ先</label>
            <input id="timecode-input" aria-label="タイムコード" placeholder="10:00:00:00" value={timecodeInput} onChange={event=>{setTimecodeInput(event.target.value);setTimecodeError("");}} onKeyDown={event=>{if(event.key==="Enter")void jumpTimecode();}} />
            <button type="button" disabled={transportBusy || !mediaInfo?.selectedTimecode} onClick={()=>void jumpTimecode()}>ジャンプ</button>
          </div>
        </div>
        {timecodeError && <p className="timecode-error">{timecodeError}</p>}
        <div className="button-row">
          <button type="button" disabled={transportBusy || playerState === "playing"} onClick={() => void play()}>再生</button>
          <button type="button" disabled={playerState !== "playing"} onClick={() => playerRef.current?.pause()}>一時停止</button>
          <button type="button" disabled={transportBusy} onClick={() => void stop()}>停止</button>
          <button type="button" disabled={transportBusy} aria-pressed={meterEnabled} onClick={() => setMeterEnabled(value => !value)}>
            音声メーター {meterEnabled ? "ON" : "OFF"}
          </button>
        </div>
        {meterEnabled && (
          <p className="meter-hint">
            音声メーターは映像右端に重ねて表示されます。振れない場合は「STREAMING診断」の音声状態を確認してください
            (対応PCM音声・ミュート解除・再生速度1x以外では意図的に無音になります)。
          </p>
        )}
        <div className="button-row">
          {/* The selected speed comes from the library's onPlaybackRateChange, not from the click. */}
          {[-4, -2, -1.5, 1, 1.5, 2, 4].map(value => (
            <button key={value} type="button" className={rate === value ? "selected" : undefined} disabled={transportBusy} aria-pressed={rate === value}
              onClick={() => void playerRef.current?.setPlaybackRate(value)}>
              {value > 0 ? `${value}x` : `${Math.abs(value)}x 逆`}
            </button>
          ))}
        </div>
        <div className="button-row">
          <button type="button" disabled={transportBusy} onClick={() => void playerRef.current?.seekRelative(-5)}>5秒戻る</button>
          <button type="button" disabled={transportBusy} onClick={() => void playerRef.current?.stepFrame(-1)}>コマ戻し</button>
          <button type="button" disabled={transportBusy} onClick={() => void playerRef.current?.stepFrame(1)}>コマ送り</button>
          <button type="button" disabled={transportBusy} onClick={() => void playerRef.current?.seekRelative(5)}>5秒進む</button>
        </div>
        <div className="seek-row">
          <span>{formatTime(currentTime)}</span>
          <input
            aria-label="再生位置"
            type="range"
            min="0"
            max={info?.duration ?? 0}
            step="0.04"
            value={Math.min(currentTime, info?.duration ?? 0)}
            disabled={transportBusy}
            onChange={(event) => seek(Number(event.target.value))}
          />
          <span>{formatTime(info?.duration ?? 0)}</span>
        </div>
      </section>

      <section className="status-grid" aria-live="polite">
        <div className="panel playback-summary"><h2>再生状態</h2><strong className={`status status-${playerState}`}>{stateLabels[playerState]}</strong><p>再生速度: {rate > 0 ? `${rate}x` : `${Math.abs(rate)}x 逆`}</p><p>音声メーター: {meterEnabled ? "計測中" : "停止"}</p><p>再生位置: {formatTime(currentTime)}</p><p>タイムコード: {timecode ?? "タイムコードなし"}</p><h2 className="error-heading">エラー</h2><p className={error ? "status-error-message" : undefined}>{error || "エラーはありません"}</p></div>
        <div className="panel media-inspection">
          <h2>MXF解析情報</h2>
          <dl>
            <dt>Operational Pattern</dt><dd>{obtained(mediaInfo?.operationalPattern)}</dd>
            <dt>Essence Container</dt><dd>{obtained(mediaInfo?.essenceContainer)}</dd>
            <dt>解像度</dt><dd>{mediaInfo?.video?.width !== undefined && mediaInfo.video.height !== undefined ? `${mediaInfo.video.width} × ${mediaInfo.video.height}` : "未取得"}</dd>
            <dt>Edit Rate</dt><dd>{mediaInfo?.editRateNumerator !== undefined && mediaInfo.editRateDenominator !== undefined ? `${mediaInfo.editRateNumerator}/${mediaInfo.editRateDenominator}` : "未取得"}</dd>
            <dt>Aspect Ratio</dt><dd>{obtained(mediaInfo?.video?.aspectRatio)}</dd>
            <dt>音声Sample Rate</dt><dd>{mediaInfo?.audio?.sampleRate !== undefined ? `${mediaInfo.audio.sampleRate} Hz` : "未取得"}</dd>
            <dt>チャンネル数</dt><dd>{obtained(mediaInfo?.audio?.channels)}</dd>
            <dt>Quantization Bits</dt><dd>{mediaInfo?.audio?.bitsPerSample !== undefined ? `${mediaInfo.audio.bitsPerSample} bit` : "未取得"}</dd>
            <dt>Timecode Track数</dt><dd>{mediaInfo ? mediaInfo.timecodeTrackCount : "未取得"}</dd>
            <dt>選択された開始TC</dt><dd>{obtained(selectedStartTimecode)}</dd>
            <dt>Drop Frame</dt><dd>{mediaInfo?.selectedTimecode ? (mediaInfo.selectedTimecode.dropFrame ? "あり" : "なし") : "未取得"}</dd>
            <dt>Index Table</dt><dd>{mediaInfo ? `${mediaInfo.indexTableCount > 0 ? "あり" : "なし"}（${mediaInfo.indexTableCount} table / ${mediaInfo.indexEntryCount} entries）` : "未取得"}</dd>
          </dl>
        </div>
        <div className="panel streaming-diagnostics"><h2>Streaming診断</h2><p>方式: {mode} / 描画: {diagnostics?.videoRenderMode??videoRenderMode} / 描画実装: {diagnostics?.rendererBackend??"-"}</p><p>速度: {diagnostics?.playbackRate??rate}x / フレーム選択: {diagnostics?.frameSelection??"-"} / 音声速度: {diagnostics?.audioPlaybackRate===0?"ミュート":`${diagnostics?.audioPlaybackRate??1}x`}</p><p>実行: {diagnostics?.decoderExecution??"-"} / 適応バッファ: {diagnostics?.adaptiveVideoAheadSeconds?.toFixed(1)??"-"}s / 補充開始: 残り{diagnostics?.adaptiveRefillThresholdSeconds?.toFixed(1)??"-"}s / 再利用プール: {diagnostics?.pooledVideoFrames??0} frames</p><p>バッファ目標: {diagnostics?.adaptiveVideoAheadSeconds?.toFixed(1)??"-"}s / {formatMB(diagnostics?.adaptiveVideoQueueMaxBytes)}（上限 {formatMB(diagnostics?.videoQueueMaxBytes)}） / 保持(再生済み): {diagnostics?.adaptiveRetainBehindSeconds?.toFixed(2)??"-"}s</p><p>実バッファ量: {diagnostics?.videoQueueFrames??0} frames / {formatMB(diagnostics?.videoQueueBytes)}</p><p>メモリ({diagnostics?.memoryApiAvailable?"performance.memory":"未対応環境のため固定値"}): {diagnostics?.memoryApiAvailable?`使用中 ${formatMB(diagnostics?.jsHeapUsedBytes??undefined)} / 上限 ${formatMB(diagnostics?.jsHeapLimitBytes??undefined)}（余裕 ${formatMB(diagnostics?.jsHeapAvailableBytes??undefined)}）`:"Chrome/Edge以外ではヒープ計測不可"} / バッファ目標調整: {diagnostics?.memoryBufferAdjustmentCount??0} 回{diagnostics?.memoryBufferAdjustments?.length?`（直近: ${diagnostics.memoryBufferAdjustments.at(-1)!.direction==="decreased"?"縮小":"拡大"} → ${diagnostics.memoryBufferAdjustments.at(-1)!.videoAheadSeconds.toFixed(1)}s）`:""}</p><p>バッファリング: {diagnostics?.bufferingEventCount??0} 回 / 合計 {formatMs(diagnostics?.bufferingTotalMs)}</p><p>映像性能: decode {diagnostics?.videoDecodeMs.toFixed(1)??"-"} ms / RGBA変換 {diagnostics?.videoColorConvertMs.toFixed(1)??"-"} ms / GPU転送・描画 {diagnostics?.videoUploadMs.toFixed(1)??"-"} ms / {diagnostics?.videoDecodedFrames??0} frames</p><p>TC Track: {diagnostics?.selectedTimecodeTrack??"なし"} / {diagnostics?.timecodeSelectionReason??"-"}</p><p>seek: requested {diagnostics?.requestedTimecode??diagnostics?.requestedFrame??"-"} / actual {diagnostics?.actualDisplayedFrame??"-"} / start {diagnostics?.seekStartFrame??"-"} / preroll {diagnostics?.prerollFrames??0} / {diagnostics?.seekSource??"-"}</p><p>seek I/O: {diagnostics?.seekReadBytes??0} bytes / {diagnostics?.seekElapsedMs?.toFixed(1)??"-"} ms</p><p>ファイル: {diagnostics?.fileSize??0} bytes</p><p>Reader: {diagnostics?.bytesLoaded??0} bytes / {diagnostics?.underlyingReadCount??0} reads</p><p>キャッシュ: {diagnostics?.cacheBytes??0} bytes</p><p>映像キュー: {diagnostics?.videoQueueFrames??0} frames ({diagnostics?.videoQueueStart?.toFixed(2)??"-"}–{diagnostics?.videoQueueEnd?.toFixed(2)??"-"}s)</p><p>音声状態: {mode!=="streaming"?"legacy":buffering?"buffering中":diagnostics?.streamingAudioSupported?(playerState==="playing"?"対応・再生中":"対応"):mediaInfo?.audio?"未対応形式のため映像のみ":"音声なし"}</p><p>音声形式: {diagnostics?.audioSampleRate??"-"} Hz / {diagnostics?.audioChannels??"-"} ch / track {diagnostics?.selectedAudioTrackNumber??"-"}</p><p>音声キュー: {diagnostics?.audioQueueStart?.toFixed(2)??"-"}–{diagnostics?.audioQueueEnd?.toFixed(2)??"-"}s / {diagnostics?.scheduledAudioRanges??0} nodes / {diagnostics?.audioBytesLoaded??0} bytes / {diagnostics?.audioExhausted?"終端":"補充中"}</p><p>形式判定: {diagnostics?.audioFormatBasis??"-"}</p><p>A/V drift: {diagnostics?.audioVideoDriftMs?.toFixed(1)??"-"} ms</p><p>世代: load {diagnostics?.loadGeneration??0} / seek {diagnostics?.seekGeneration??0}</p></div>
        <div className="panel measurement-panel">
          <h2>効果測定</h2>
          <p>変更前後で同じ条件で再生し、バッファリング回数・合計時間を比較するための簡易計測です。</p>
          <div className="button-row">
            <button type="button" onClick={startMeasurement}>{measurementBaseline ? "リセット" : "計測開始"}</button>
            <button type="button" disabled={!diagnostics} onClick={() => void copyDiagnostics()}>診断値をコピー</button>
          </div>
          {measurementBaseline && diagnostics && (
            <dl>
              <dt>経過時間</dt><dd>{formatMs(measurementNow - measurementBaseline.atMs)}</dd>
              <dt>バッファリング回数（計測中）</dt><dd>{(diagnostics.bufferingEventCount ?? 0) - measurementBaseline.bufferingEventCount} 回</dd>
              <dt>バッファリング合計時間（計測中）</dt><dd>{formatMs((diagnostics.bufferingTotalMs ?? 0) - measurementBaseline.bufferingTotalMs)}</dd>
            </dl>
          )}
          {copyStatus && <p className="copy-status">{copyStatus}</p>}
        </div>
      </section>
    </main>
  );
}
