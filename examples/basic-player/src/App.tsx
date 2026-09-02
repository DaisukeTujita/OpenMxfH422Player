import { useRef, useState } from "react";
import {
  H422Player,
  type H422PlayerHandle,
  type MxfMediaInfo,
  type PlayerInfo,
  type PlayerStatus,
} from "@openmxf/h422-player";

const statusLabels: Record<PlayerStatus, string> = {
  idle: "待機中",
  loading: "読み込み中",
  ready: "再生準備完了",
  playing: "再生中",
  paused: "一時停止中",
  ended: "再生終了",
  error: "エラー",
};

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
  const [seeking, setSeeking] = useState(false);

  const selectFile = (nextFile?: File) => {
    setFile(nextFile);
    setError("");
    setInfo(undefined);
    setCurrentTime(0);
    setMediaInfo(undefined);
    setTimecode(null);
    setStatus(nextFile ? "loading" : "idle");
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

  return (
    <main>
      <header>
        <p className="eyebrow">OpenMxfH422Player / Basic example</p>
        <h1>ローカルMXFプレイヤー</h1>
        <p className="description">ファイルはサーバーへ送信されず、ブラウザ内でデコードされます。</p>
      </header>

      <section className="panel file-panel">
        <label className="file-picker">
          <span>MXFファイルを選択</span>
          <input type="file" accept=".mxf,application/mxf" onChange={(event) => selectFile(event.target.files?.[0])} />
        </label>
        <span className="filename">{file?.name ?? "ファイルが選択されていません"}</span>
      </section>

      <section className="viewer" aria-label="MXF player">
        {file ? (
          <H422Player
            key={`${file.name}-${file.lastModified}`}
            ref={playerRef}
            src={file}
            controls={false}
            libavBase="/libav"
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
        <div className="panel"><h2>メディア情報</h2><p>{info ? `${mediaInfo?.video?.width ?? info.width} × ${mediaInfo?.video?.height ?? info.height} / ${mediaInfo?.editRateNumerator && mediaInfo.editRateDenominator ? `${mediaInfo.editRateNumerator}/${mediaInfo.editRateDenominator}` : info.frameRate} fps / ${mediaInfo?.audio?.channels ?? info.audioChannels} ch` : "—"}</p></div>
        <div className="panel error-panel"><h2>エラー</h2><p>{error || "エラーはありません"}</p></div>
      </section>
    </main>
  );
}
