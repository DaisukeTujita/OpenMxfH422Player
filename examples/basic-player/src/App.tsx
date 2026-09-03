import { useRef, useState } from "react";
import {
  H422Player,
  formatTimecodeFrame,
  type H422PlayerHandle,
  type MxfMediaInfo,
  type PlayerInfo,
  type PlayerStatus,
  type PlaybackMode,
  type PlayerDiagnostics,
} from "@openmxf/h422-player";

const statusLabels: Record<PlayerStatus, string> = {
  idle: "待機中",
  loading: "読み込み中",
  ready: "再生準備完了",
  playing: "再生中",
  paused: "一時停止中",
  ended: "再生終了",
  error: "エラー",
  buffering: "バッファリング中",
};

const obtained = (value: string | number | undefined) => value ?? "未取得";

const formatTime = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor(safeSeconds / 60) % 60;
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const milliseconds = Math.floor((safeSeconds % 1) * 1000);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${wholeSeconds.toString().padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
};

export function App() {
  const playerRef = useRef<H422PlayerHandle>(null);
  const [file, setFile] = useState<File>();
  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [error, setError] = useState("");
  const [info, setInfo] = useState<PlayerInfo>();
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaInfo, setMediaInfo] = useState<MxfMediaInfo>();
  const [timecode, setTimecode] = useState<string | null>(null);
  const [timecodeInput, setTimecodeInput] = useState("");
  const [timecodeError, setTimecodeError] = useState("");
  const [seeking, setSeeking] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [mode,setMode]=useState<PlaybackMode>("streaming");
  const [diagnostics,setDiagnostics]=useState<PlayerDiagnostics>();
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
    setStatus(nextFile ? "loading" : "idle");
    setBuffering(false);
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

  return (
    <main>
      <header>
        <p className="eyebrow">OpenMxfH422Player / Basic example</p>
        <h1>ローカルMXFプレイヤー</h1>
        <p className="description">ファイルはサーバーへ送信されず、ブラウザ内でデコードされます。</p>
      </header>

      <section className="panel file-panel">
        <label className="mode-control">再生方式
          <select value={mode} onChange={event=>{const nextMode=event.target.value as PlaybackMode;console.info("[H422Player example] playback mode changed", { from: mode, to: nextMode });setBuffering(false);setMode(nextMode);}}>
            <option value="streaming">Streaming</option>
            <option value="legacy">Legacy</option>
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
          <H422Player
            key={`${file.name}-${file.lastModified}-${mode}`}
            ref={playerRef}
            src={file}
            controls={false}
            libavBase="/libav"
            mode={mode}
            onDiagnostics={setDiagnostics}
            onBufferingChange={setBuffering}
            onReady={setInfo}
            onMediaInfo={setMediaInfo}
            onTimecode={setTimecode}
            onSeekingChange={setSeeking}
            onTimeUpdate={setCurrentTime}
            onStatusChange={setStatus}
            onError={(nextError) => setError(nextError.message)}
          />
        ) : (
          <div className="empty-state">MXFを選択すると、ここに映像が表示されます</div>
        )}
      </section>

      <section className="panel controls" aria-label="Playback controls">
        <div className="timecode-display">{timecode ?? "Timecode Trackなし"}</div>
        <div className="timecode-jump">
          <input aria-label="タイムコード" placeholder="10:00:00:00 / 10:01:00;02" value={timecodeInput} onChange={event=>{setTimecodeInput(event.target.value);setTimecodeError("");}} onKeyDown={event=>{if(event.key==="Enter")void jumpTimecode();}} />
          <button type="button" disabled={!mediaInfo?.selectedTimecode} onClick={()=>void jumpTimecode()}>ジャンプ</button>
          <button type="button" disabled={!timecode} onClick={()=>setTimecodeInput(timecode??"")}>現在位置をコピー</button>
        </div>
        {timecodeError && <p className="timecode-error">{timecodeError}</p>}
        <div className="button-row">
          <button type="button" disabled={!file || status === "loading" || status === "error"} onClick={() => void play()}>再生</button>
          <button type="button" disabled={status !== "playing"} onClick={() => playerRef.current?.pause()}>一時停止</button>
          <button type="button" disabled={!info} onClick={() => void stop()}>停止</button>
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
            disabled={!info}
            onChange={(event) => seek(Number(event.target.value))}
          />
          <span>{formatTime(info?.duration ?? 0)}</span>
        </div>
      </section>

      <section className="status-grid" aria-live="polite">
        <div className="panel"><h2>再生状態</h2><strong className={`status status-${status}`}>{seeking ? "シーク中" : statusLabels[status]}</strong><p>再生位置: {formatTime(currentTime)}</p><p>タイムコード: {timecode ?? "タイムコードなし"}</p></div>
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
        <div className="panel error-panel"><h2>エラー</h2><p>{error || "エラーはありません"}</p></div>
        <div className="panel"><h2>Streaming診断</h2><p>方式: {mode}</p><p>TC Track: {diagnostics?.selectedTimecodeTrack??"なし"} / {diagnostics?.timecodeSelectionReason??"-"}</p><p>seek: requested {diagnostics?.requestedTimecode??diagnostics?.requestedFrame??"-"} / actual {diagnostics?.actualDisplayedFrame??"-"} / start {diagnostics?.seekStartFrame??"-"} / preroll {diagnostics?.prerollFrames??0} / {diagnostics?.seekSource??"-"}</p><p>seek I/O: {diagnostics?.seekReadBytes??0} bytes / {diagnostics?.seekElapsedMs?.toFixed(1)??"-"} ms</p><p>ファイル: {diagnostics?.fileSize??0} bytes</p><p>Reader: {diagnostics?.bytesLoaded??0} bytes / {diagnostics?.underlyingReadCount??0} reads</p><p>キャッシュ: {diagnostics?.cacheBytes??0} bytes</p><p>映像キュー: {diagnostics?.videoQueueFrames??0} frames ({diagnostics?.videoQueueStart?.toFixed(2)??"-"}–{diagnostics?.videoQueueEnd?.toFixed(2)??"-"}s)</p><p>音声状態: {mode!=="streaming"?"legacy":buffering?"buffering中":diagnostics?.streamingAudioSupported?(status==="playing"?"対応・再生中":"対応"):mediaInfo?.audio?"未対応形式のため映像のみ":"音声なし"}</p><p>音声形式: {diagnostics?.audioSampleRate??"-"} Hz / {diagnostics?.audioChannels??"-"} ch / track {diagnostics?.selectedAudioTrackNumber??"-"}</p><p>音声キュー: {diagnostics?.audioQueueStart?.toFixed(2)??"-"}–{diagnostics?.audioQueueEnd?.toFixed(2)??"-"}s / {diagnostics?.scheduledAudioRanges??0} nodes / {diagnostics?.audioBytesLoaded??0} bytes / {diagnostics?.audioExhausted?"終端":"補充中"}</p><p>形式判定: {diagnostics?.audioFormatBasis??"-"}</p><p>A/V drift: {diagnostics?.audioVideoDriftMs?.toFixed(1)??"-"} ms</p><p>世代: load {diagnostics?.loadGeneration??0} / seek {diagnostics?.seekGeneration??0}</p></div>
      </section>
    </main>
  );
}
