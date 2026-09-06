# H422Player

## ReaderベースのMXF索引

MXFメタデータ、Partition Pack、Random Index Pack、Index Table Segmentの調査は
`RandomAccessReader`を使用します。ローカルの`File`/`Blob`は`Blob.slice()`で
アラインされた範囲だけを読み、既定値は1 MiBチャンク、64 MiBのLRUキャッシュ、
単一`read()`最大4 MiBです。同一チャンクの同時要求共有、AbortSignal、統計取得に
対応し、各値は`FileRandomAccessReader`のオプションで変更できます。RIPがない、
または壊れている場合は、KLV ValueをLengthで読み飛ばす安全な順次走査を行います。
有効なRIPがある場合は全域を順次走査せず、RIPが示す各Partition Packと、
Partition Pack直後の`HeaderByteCount`および`IndexByteCount`範囲だけを解析します。

メタデータ解析に続き、Essence KLVもValueを読まずにBER Lengthで読み飛ばして索引化します。
索引にはKLV/value offset、value length、track number、BodySID、映像・音声種別、
edit unit、presentation time、所属Partition、および利用可能なIndex Entry情報を保持します。
`readEssenceRange()`は指定フレーム範囲だけを最大4 MiB単位で読み、Index Entryの
KeyFrameOffset/RAPを優先して復号開始点を決めます。Index情報がない場合の既定prerollは45フレームです。

PlayerEngine の `streaming` モードはこの索引と区間取得APIを使用し、区間読み込みから区間デコードまで
接続済みです。`legacy` は既存OP1a/XDCAM HD422との互換性を優先し、従来どおり全体を読み込んで
全フレームをデコードします。API既定値は現在も `legacy` で、streaming を使うには明示指定が必要です。

索引処理はEssence Valueを個別の`Uint8Array`として生成しないため、ピークメモリを抑えます。
ただし`FileRandomAccessReader`は既定で1 MiB単位のアライン済みチャンクを読むため、KLV間隔が
チャンクより短いファイルでは、ヘッダー走査だけでも物理I/Oがファイルの大部分に及ぶ可能性が
あります。「常にファイル全体より少ないI/O」は保証しません。PlayerEngineの区間デコード接続は
実装済みです。HTTP Range向けの小さなヘッダーキャッシュ／Reader設計は引き続き次段階の対象です。

React向けのブラウザ完結型 **MXF OP1a / MPEG-2 422P@HL** プレイヤーです。MPEG-2をWebCodecsへ渡さず、専用構成のlibav.js WebAssemblyでデコードしてCanvas（WebGL）へ表示します。描画は `videoRenderMode` で選べ、`yuv-webgl` はyuv422p平面をそのままGPUへ転送してシェーダーで変換し、`rgba` はCPUでRGBAへ変換します。48 kHz / 24-bit PCMはplanar `Float32Array`へ変換してWeb Audio APIで再生します。

## Windows 11（PowerShell）での起動

```powershell
git clone https://github.com/DaisukeTujita/OpenMxfH422Player.git
Set-Location OpenMxfH422Player
npm install
npm run dev
```

Node.js 20以上を使用してください。`npm run dev`は、再生モード選択、タイムコード表示、タイムコード指定ジャンプを備えた`examples/basic-player`を起動します。従来の簡易デモは`npm run dev:simple`で起動できます。

初回起動時は、バージョンを固定したカスタムlibav.jsをGitHub Releaseから自動取得し、SHA-256を検証して`libav/dist`へ配置します。**Bash、Make、WSL、Emscriptenは不要**です。取得だけを先に行う場合は`npm run setup:libav`を実行できます。

## カスタムWASMの構成と配布

`libav/config.json`が再現可能な最小構成です。MXF demuxer、MPEG-2 Video parser/decoder、signed 24-bit PCM decoder（BE/LE）、swscale、swresampleを含みます。配布者用の`scripts/build-libav-h422.sh`はlibav.js **v6.10.9.0**を取得して`h422` variantを生成します。GitHub Actionsの`Verify or publish custom libav.js assets` workflowはPRでも既定で検証だけを行います。Release公開はmainブランチから手動実行し、`publish`を明示的に選んだ場合に限られます。`libav/assets.json`にはRelease URL、ファイル名、SHA-256を固定しています。生成物とWASMはGitには登録しません。

通常の利用者は`build:libav`を実行しません。Release更新時だけ、配布者が生成物のSHA-256を`libav/assets.json`へ反映してからworkflowを実行します。workflow自身も公開前に同じハッシュを検証するため、設定と異なる生成物を誤って配布しません。

WASMのSHA-256は、同じFFmpeg tagでも取得物やbuild metadataが異なれば変化します。Codex CloudでFFmpeg公式tarballの代わりにGitHub checkoutから作った代替tarballを使用したbuildは、JavaScript glueが一致してもWASM本体がActions buildと一致しませんでした。公開workflowは異なる絶対パスへソースを取得して2回clean buildし、3ファイルがbyte-for-byteで一致した場合だけ先へ進みます。またWASM custom sectionを解析し、debug/source-map sectionやrunner、workspace、Windowsの絶対パスが含まれていないことを確認します。manifestの値はこの再現性検査を通るGitHub Actions buildを基準にします。

独自CDNへ配置する場合は、生成した`libav-h422.mjs`と`*-h422.wasm.mjs`、`*-h422.wasm.wasm`を同じ公開ディレクトリへ置き、そのURLを`libavBase`へ指定してください。

## React

```tsx
import { H422Player } from "@openmxf/h422-player";

export default function Preview({ file }: { file: File }) {
  return <H422Player src={file} mode="streaming" libavBase="/libav" controls onError={console.error} />;
}
```

`videoRenderMode` の既定値は `yuv-webgl` で、yuv422p平面をそのままGPUへ転送しシェーダーで変換します。CPU変換が必要な場合は `rgba` を指定してください。**WebGLコンテキストが取得できない環境では2D canvasへ自動フォールバックし、`rgba` を強制します**（平面YUVを2D canvasで変換する手段がないため）。フォールバックしたかどうかは診断値 `rendererBackend`（`"webgl"` または `"canvas2d"`）で判別できます。

`mode` は `"legacy" | "streaming"` で、既定値は安全な `legacy` です。streaming では
`readWhole()` を呼ばず、1回約3秒（`chunkSeconds`）の区間を取得してデコードします。先読み目標は
既定6秒で、実測したデコード時間に応じて最大9秒まで自動的に伸び、さらに後述のバイト上限で
頭打ちになります。残り時間が補充しきい値（既定4秒、これも実測に応じて伸びる）を切ると補充を開始し、
再生位置から `retainBehindSeconds`（既定1秒）より古いフレームを破棄します。seek時は旧要求をAbortし、
Worker側で未処理のデコードも破棄して、seek先付近だけを取得し直します。

破棄と補充、および終端判定は `requestAnimationFrame` ではなく250 msの独立したタイマーで行います。
タブが非表示になるとrAFは停止しますが、このタイマーは動き続けるため、非表示のままでもキューは
際限なく伸びず、終端まで再生すれば `ended` が遅延なく通知されます。
MXF先頭にSMPTEで許容される最大65,535 byteのRun-inがある場合も、Header Partitionを検出して部分読み込みを開始します。Timecode Trackは再生の必須条件ではなく、存在しない素材ではタイムコード表示とタイムコード指定ジャンプだけが無効になります。
`ref.getDiagnostics()` と `onDiagnostics` からReader I/O、キャッシュ、キュー、世代を確認できます。

### デコードの実行環境

デコード、平面抽出、RGBA変換はすべて専用のWeb Worker（`video-decode-worker.ts`）で実行し、メインスレッドは描画とスケジューリングだけを担当します。libav.js自体は `noworker: true` で**このWorker内に直接**読み込みます。libav.jsに自前のWorkerを立てさせると、デコード済みフレームがWorker境界を2回越えることになり、実測で約1割のスループット低下になるためです。

Workerへの要求は到着順に1件ずつ処理します。libavインスタンスは1つしかないため、デコード中に別のデコードやデコーダー解放が割り込むと、同じインスタンスに対して複数の要求が同時に走ります。直列化により「デコード完了 → invalidate完了 → 旧デコーダー解放完了 → 新デコーダー初期化」の順序を保証しています。seekなどでキュー内の未処理デコードが無効になった場合は、実行せずに破棄します。

デコード済みフレームはWorkerからメインスレッドへ **transfer** で渡し（構造化複製をすると1チャンクで数百MBのコピーが発生します）、再生位置が通り過ぎたフレームのバッファは次のデコード要求に相乗りしてWorkerへ返却され、再利用プールに入ります。1080iの1フレームは約4.15 MBあるため、これがないと定常再生で毎秒100 MBを超えるゴミが発生します。プールの保持量は診断値 `pooledVideoFrames`、実行環境は `decoderExecution` で確認できます。

### 映像キューのメモリ上限

デコード済みフレームがこのプレイヤーのメモリ使用量の大半を占めます。1080ラインの4:2:2は1フレーム約4.15 MBなので、先読みを秒数だけで管理すると適応バッファが落ち着く9秒で1.2〜1.5 GBに達します。`videoQueueMaxBytes` は保持するデコード済み映像のバイト数上限で、秒数の先読み目標と**併用**され、先に到達した方が補充を止めます。

```tsx
import { H422Player, DEFAULT_VIDEO_QUEUE_MAX_BYTES } from "@openmxf/h422-player";

<H422Player src={file} mode="streaming" videoQueueMaxBytes={256 * 1024 * 1024} />
```

補充は1回で `chunkSeconds` 分をまとめてデコードするため、キューのピークは「先読み＋1チャンク」になります。上限からチャンク1個分を差し引いた値が先読み目標になり、ピークが上限に一致します。

下限を決めるのは好みではなく停止です。先読みがチャンク1個のデコード時間（1080iの3秒チャンクで実測約2.7秒）を下回ると、補充のたびに再生が枯渇します。

既定値 `DEFAULT_VIDEO_QUEUE_MAX_BYTES` は1 GiBです。1080i素材で約258フレーム、うち先読みが約168フレーム（29.97 fpsで約5.6秒）、その上に90フレームのチャンクが乗ります。

この値は計算ではなく実測で決めています。参照用の1080iサンプルでは、上限なしの約1467 MBに対して**約730 MBで、バッファリング停止なしに再生**できました。先読みが約3.5秒しか残らない768 MiBでは、同じマシンで負荷によりデコードが遅くなった際に停止しました。なお**効くのは上限値よりマシン性能です**。デコードは負荷状況により0.6〜1.2倍リアルタイムの幅で変動し、デコードが追いつかない状態はどんなバッファサイズでも救えません。

引き上げると停止しにくくなります。**チャンク2個分を下回る値まで下げると、先読みがチャンク1個のデコードを覆えなくなるため、メモリと引き換えに再生の滑らかさを失います。** 現在値と上限は診断値 `videoQueueBytes` / `videoQueueMaxBytes` で確認できます。

streaming音声はDescriptorが **48 kHz / 24-bit / 2 ch** でSound Essence packetが存在し、取得できたBlockAlignが6、取得できたSound Essence Coding ULが非圧縮PCM系の場合に対応します。signed PCM・big-endian・BlockAlignがメタデータで明示されない素材では、対応対象であるXDCAM HD422 OP1aプロファイルからPCM S24BE（BlockAlign 6 byte）と推定しており、完全にメタデータ判定済みとは表示しません。複数トラックはKLV検出順の最初のステレオtrackNumberを選び、選択理由をログへ出します。Descriptorが欠落または不一致なら固定値で推測せず、理由を警告して映像のみ再生へフォールバックします。音声はReaderから3秒先まで（単一read最大4 MiB）だけ取得し、約0.75秒のAudioBufferへ変換します。残量1.25秒で補充し、再生済み区間を破棄するため未再生キューは概ね3秒（補充中も最大約5秒）です。performance.now()を映像・media timeのマスター時計、AudioContextを音声予約時計として使用し、audioVideoDriftMsで差を監視します。開始時は両時計を30 ms後の同一点へ揃えます。各区間はmedia timeアンカーから予約し（大きな無音区間を詰めず）、pause/seek/buffering/endedでは全Nodeをstop・disconnect、復旧時は同一media timeからNodeを作り直します。音声には映像prerollを適用せず、seek packet内も6-byte境界で切り出し、映像durationを越えて予約しません。映像または対応音声が枯渇した場合は再生時計を停止してbufferingを通知し、補充後に同じ位置から再開します。Index Tableの
`StreamOffset`はBodySIDのEssence Container stream先頭を基準とする相対値であり、Partitionの
絶対位置へ単純加算できません。本実装は推測による直接変換をせず、安全なKLVヘッダー順次索引へ
フォールバックします。このためEssence Valueのメモリ化は避けますが、初回の物理I/O時間は
ファイル長に比例し得ます。

入力が `File` / `Blob` の場合は `Blob.slice()` により必要な物理範囲だけを読みます。一方、文字列URLは
現在 `fetch(url).blob()` でファイル全体をダウンロードした後にReaderを作成します。HTTP Rangeによる
ネットワークストリーミングは未対応であり、URL指定時の通信量は削減されません。

`PlayerInfo.audioChannels` は「現在再生可能な音声チャンネル数」です。このため映像のみのstreamingでは
音声なし、muted、または未対応Descriptorでは `0` を返し、音声Essence Valueを読み込みません。診断には対応状態、選択trackNumber、形式、音声キュー範囲、予約Node数、読込byte数、A/V driftを含みます。

`src`には`File`、`Blob`、またはCORSを許可したURLを指定できます。`ref`から`play()`、`pause()`、`seek(seconds)`、`stepFrame(frames)`、`seekRelative(seconds)`、`seekTimecode(timecode)`、`setPlaybackRate(rate)`、`currentTime`、`duration`、`playbackRate`、`state`、`getAudioLevels()`、`setAudioLevelsEnabled(enabled)`、`audioLevelsEnabled`、`getDiagnostics()`を利用できます。

`stepFrame(frames)` はコマ送り／コマ戻しです（負値で後方）。再生中に呼ぶと**先に一時停止します**。そうしないと再生時計が進んで、seekが着地する前に目的フレームを通り過ぎるためです。`seekRelative(seconds)` は相対スキップで、素材範囲へクランプされ、再生中ならそのまま再生を続けます。どちらも既存の世代管理付きseekを経由するため、`onSeekingChange` が通常どおり通知されます。

### 再生速度と早戻し

`setPlaybackRate(rate)` で速度を設定します。**符号付き**で、負値が逆再生です。速度と方向を別々に持つ設計も考えられますが、値が1つなら「速度0で方向あり」のような不正な組み合わせが存在せず、再生時計も `アンカー + 経過時間 × rate` で方向が自然に出るため、符号付きを採用しています。`0` は「再生中なのに進まない」を意味するため拒否します。停止は `pause()` です。現在値は `ref.playbackRate` と診断値 `playbackRate` で読めます。

**全フレームをデコードする方式では2倍速・4倍速は物理的に不可能です。** 全フレームデコードには速度に比例したスループットが必要で、本実装の1080iは実測で概ね1.0〜1.2倍リアルタイムです。2倍速には約2.4倍、4倍速には約4.8倍が必要で、バッファを厚くしても埋まりません。

そのため以下のように自動で切り替えます。

| 速度 | フレーム選択 | 音声 |
|---|---|---|
| 1.0x | 全フレーム | 再生 |
| 1.5x（`fullDecodeMaxRate` 既定値まで） | 全フレーム | `playbackRate` で再生（ピッチは上がります） |
| 2.0x / 4.0x | **Iフレームのみ**（間引き表示） | ミュート |
| 逆再生（全速度） | **Iフレームのみ** | ミュート |

閾値はハードコードせず `fullDecodeMaxRate`（既定 `DEFAULT_FULL_DECODE_MAX_RATE` = 1.5）で設定できます。SIMDビルド等でデコードが速くなれば、コード変更なしにより高速域まで全フレームデコードへ回せます。

**逆再生は全速度でIフレームのみです。** MPEG-2 Long-GOPは後ろ向きにデコードできないため、逆方向1.5倍であってもGOP全体を前向きにデコードして大半を捨てる必要があり、実効コストは順方向の4〜5倍になります。Iフレームのみなら1 GOP（12〜15フレーム）あたり1枚で済み、桁で軽くなります。

Iフレームの位置はMXF Index EntryのKeyFrameOffset / RandomAccessPoint / Flagsから判定します。**索引にRandom Access Pointが1つも無い素材では間引き再生ができず**、その旨のエラーになります。実際にどちらで動作しているかは診断値 `frameSelection`（`"all-frames"` / `"key-frames"`）と `audioPlaybackRate`（ミュート時は `0`）で確認できます。

#### 現在の速度を知る

現在値は `ref.playbackRate`（符号付き）と診断値 `playbackRate` で読めます。変化の通知は
`onPlaybackRateChange(rate, info)` です。**速度を変えた経路によらず**、エンジンが実際に採用した値だけを
1回通知します（同じ値の再設定では発火しません）。素材の読み込み完了時にも現在値を1回通知するため、
購読側は初期値を別途問い合わせる必要がありません。`info` には速度そのものに加えて、
`frameSelection`（`"all-frames"` / `"key-frames"`）と `audioPlaybackRate`（ミュート時 `0`）が入ります。
速度ボタンのハイライトは、クリック値ではなくこの通知値で行ってください。閾値をまたいだ操作や
将来の自動フォールバックでも、UIとエンジンの表示がずれません。

#### 再生を止めない速度変更

`setPlaybackRate()` は**一時停止を要求しませんし、内部で停止と再開もしません**。再生中に呼べば再生中のまま
切り替わります。同じフレーム選択方式内での変更（例: 1.0x → 1.5x）は再生時計の張り直しと音声予約の
作り直しだけで、映像の供給は途切れません。

方式をまたぐ変更のうち、**同じ方向で全フレーム→Iフレーム間引きへ上げる場合（例: 1.0x → 4.0x）は
再シークしません。** 全フレームのキューは間引き再生が表示するIフレームをすべて含んでいるため、キューを
保持したまま以降の補充だけを間引きへ切り替えれば、映像は途切れずに進みます。このときデコード済みの
末尾（`queuedThroughFrame`）を間引き補充の開始点として引き継ぐため、同じ区間を二度デコードしません。
再生中にこの切り替えを行う条件は、新しい速度で**0.5秒以上の実時間**を賄えるだけのキューが
先読み側に残っていることです。足りない場合は下と同じ再シークにフォールバックします。

それ以外の方式変更、すなわち**Iフレーム間引き→全フレームへ戻す場合（例: 4.0x → 1.0x）と方向反転**は
再シークします。前者はIフレームの間のフレームが、後者は進行方向と反対側のフレームが、いずれもキューに
存在しないためです。この間の状態は `seeking` になり、キューが埋まると同じ位置から再生を再開します。

なお方式をまたぐ変更では**音声の連続性は保てません**。上の表のとおり間引き再生と逆再生は音声をミュートし、
予約済みのAudioBufferSourceNodeをすべて解放するためです。速度を1.0xへ戻すと、再シーク後に同じ位置から
音声予約を作り直します。

### 再生状態とローディング表示

待ち状態は個別のフラグではなく、購読可能な1つの列挙値 `PlayerState` として公開します。

| 値 | 意味 |
|---|---|
| `idle` | 素材未指定 |
| `loading` | ファイル読み込み・解析中（**待ち**） |
| `ready` | 読み込み完了、未再生 |
| `seeking` | シーク中。**速度変更に伴う再初期化もここに入ります**（**待ち**） |
| `buffering` | バッファ枯渇による停止、または補充待ち（**待ち**） |
| `playing` / `paused` / `ended` | 定常状態 |
| `error` | 失敗 |

```tsx
import { H422Player, isWaitingPlayerState, type PlayerState } from "@openmxf/h422-player";

const [state, setState] = useState<PlayerState>("idle");
<H422Player src={file} onStateChange={setState} />
{isWaitingPlayerState(state) && <Spinner />}
```

`onStateChange` は**値が実際に変わったときだけ**1回通知します。`WAITING_PLAYER_STATES` と
`isWaitingPlayerState(state)` は「スピナーを出し、操作を落とす」区間、すなわち `loading` / `seeking` /
`buffering` を判定するためのヘルパーです。合成規則は `derivePlayerState()` として公開しており、
`error` > `loading` > `seeking` > `buffering` の順で優先します。シークが枯渇補充を伴っても
`buffering` ではなく `seeking` と報告するのは、原因の方をホストに見せるためです。

従来の `onStatusChange`（`PlayerStatus`）、`onSeekingChange`、`onBufferingChange` は**そのまま残ります**。
`PlayerState` はそれらを合成した派生値であり、置き換えではありません。**どのUIを非活性にするかは
ホストアプリの責務**で、ライブラリは状態提供に留めます。`examples/basic-player` は
`isWaitingPlayerState()` の結果でスピナーを重ね、再生／一時停止／シーク／速度変更ボタンを落としています。
音声はブラウザのautoplay policyにより通常ユーザー操作後に開始します。シーク時はAudioBufferSourceNodeを
指定位置から作り直します。

### 音声レベルメーター

再生中の音声レベルを一定間隔で計測して通知します。**計測はライブラリ、描画はホスト**の分担です。

```tsx
import { H422Player, type AudioLevels } from "@openmxf/h422-player";

const [levels, setLevels] = useState<AudioLevels>();
<H422Player src={file} enableAudioLevels={metersVisible} onAudioLevelUpdate={setLevels} audioLevelIntervalMs={100} />
```

- **値**: チャンネルごとに `peak` / `rms`（線形、フルスケール1.0）と `peakDb` / `rmsDb`（dBFS）。
  dB値は `AUDIO_LEVEL_SILENCE_DB`（-100 dBFS）で下限クランプします。デジタル無音は -∞ dBで、
  そのままではメーターのレイアウトができないためです。24-bit素材のノイズフロアより下なので
  可聴情報は失われません。フルスケールを超える素材は 0 dBFSでクランプせず、そのまま正値になります。
- **対象チャンネル**: 先頭の1ch・2chのみ。3ch以上ある素材でも3ch目以降は読みません
  （`AUDIO_LEVEL_MAX_CHANNELS`）。
- **更新頻度**: `audioLevelIntervalMs`（既定 `DEFAULT_AUDIO_LEVEL_INTERVAL_MS` = 100 ms）。この値は
  計測窓の長さでもあります。100 msは29.97 fpsで約3フレームに1回で、メーターの追従としては十分速く、
  1回あたり48 kHz×2chで9,600サンプル程度の走査に収まります。下限は映像1フレーム分で、それより
  短くしても同じ窓を二度読むだけです。この値はマウント時に読み、以降の変更は反映しません。
- **計測方法**: 出力にAnalyserNodeを挿すのではなく、**デコード済みPCMを再生位置から読んで**計測します。
  音声グラフはこのプレイヤーで再生タイミングが依存している唯一の場所であり、そこに分岐を足したくないこと、
  およびlegacyモードでは意味のある値が取れないことが理由です。窓は再生位置から**前方**へ取ります。
  再生位置より後ろのフレームは約100 msで破棄されるため、後方窓では破棄と競合します。
- **静音を返す条件**: 再生中でないとき、速度によって音声がミュートされているとき（間引き・逆再生）、
  および音声が無い・未対応形式のとき。最後の値を保持せず、メーターが下がりきります。
- **有効/無効**: `enableAudioLevels`（既定 `false`）。無効の間はタイマー自体が存在せず、サンプルを
  1つも読みません。`ref.setAudioLevelsEnabled(enabled)` で実行時に切り替えられ、**この切り替えでは
  ファイルを読み直しません**。`ref.getAudioLevels()` は最新値（無効時は `null`）を返します。
- **既知の制約**: `muted` で初期化した場合、streaming音声はそもそも読み込まれないため、レベルは
  常に無音です。またレベルは復号したPCMそのものの値で、AudioContextの出力ゲインは反映しません。

`examples/basic-player` は動画の右端に1ch・2chの縦バーを置き、トグルボタンで
`enableAudioLevels` ごと切り替えます（非表示時は計測も止まります）。色分け・目盛り・
ピークホールドの見た目はデモ側の設計です。

追加コールバックの `onMediaInfo` はMXFから実際に取得できた構造情報を返し、未取得フィールドは `undefined` のままです。`onTimecode` は現在位置のSMPTEタイムコード、Timecode Trackがない場合は `null` を返します。`onSeekingChange` はシーク処理の開始・終了を通知します。`onBufferingChange` はstreaming映像のバッファ枯渇・復旧、およびseek中の準備状態を重複なく通知します。`onStateChange` はそれらを合成した `PlayerState`、`onPlaybackRateChange` は採用された再生速度とその含意、`onAudioLevelUpdate` は1ch・2chの音声レベルを通知します。

## MXF解析

解析器はPartition PackのOperational Pattern、Header Metadata内のDescriptor/Track系Local Set、およびIndex Table SegmentをEssenceデコードとは分離して走査します。現在、メタデータから次の値を取得できます。

- Operational Pattern、Essence Container UL
- Stored Width / Stored Height、Aspect Ratio
- Track Edit Rate、Descriptor Duration
- Audio Sampling Rate、Channel Count、Quantization Bits
- Timecode ComponentのStart Timecode、Rounded Timecode Base、Drop Frame、Duration
- Index Edit Rate、Index Start Position、Index Duration、Edit Unit Byte Count
- Index EntryのStream Offset、Key Frame Offset、Temporal Offset、Flags

Stream OffsetはJavaScriptの安全な整数範囲に丸めず `bigint` で保持します。異なるMXF生成器がPrimer Packで動的Local Tagを割り当てるケースの完全対応、Codec/Pixel Format ULの網羅的な名称解決、Package参照を辿ったMaterial/Sourceの優先順位付けは今後の拡張対象です。解析できない値に1920×1080等の固定値を代入することはありません。一方、既存デコード経路は従来互換の対象形式に限り、libav codec ID、30000/1001 fps、48 kHz、2 chを引き続き利用します。このフォールバックは、メタデータから確定できない値があっても既存素材を再生可能に保つための措置です。

## タイムコード表示

### タイムコードジャンプUI

現在タイムコードの見やすい表示と、Non-Drop Frameの`HH:MM:SS:FF`、Drop Frameの`HH:MM:SS;FF`入力に対応します。TimecodeTrack.startFrameとの差からmedia frameを計算し、素材範囲外と不正Drop Frame番号を検証して、legacy/streaming共通の世代管理付きseekを実行します。

サンプル画面はミリ秒単位の再生位置とMXFタイムコードを併記します。Non-Drop Frameに加え、29.97 fps（base 30）と59.94 fps（base 60）のDrop Frame番号を扱い、区切りはDrop Frameでは `;`、Non-Dropでは `:` です。開始タイムコードへ現在の再生フレームを加算し、24時間でラップします。利用可能なTimecode Trackがない場合は「タイムコードなし」と表示し、再生自体は継続します。

### 複数Timecode Trackの選択規則

Preface、ContentStorage、MaterialPackage、SourcePackage、Track、Sequence、SourceClip間の参照解析は未対応です。複数のTimecode Trackでは、**常にMXF内のKLV検出順で最初に現れ、Edit Rateの分子・分母がともに正数であるTrack**を使用します。診断にも「Package参照解析は未対応のためKLV検出順で選択」と明示し、Material Packageであるという未検証の推測は行いません。

サンプルの「MXF解析情報」にはOperational Pattern、Essence Container、解像度、Edit Rate、Aspect Ratio、音声Sample Rate、チャンネル数、Quantization Bits、Timecode Track数、選択された開始タイムコード、Drop Frame、Index Table数とEntry総数を表示します。メタデータから取得できなかった項目を再生用固定値で補完せず、「未取得」と表示します。

## Indexとシーク

`findSeekPoint()` は目的Edit Unit以前のRandom Access Pointを選択します。Index Entryがない場合は、固定Edit Unit Byte Countだけでは独立デコード可能と判断せず、`source: "sequential-fallback"`として先頭からの順次走査を明示します。streamingシークはIndex EntryのKeyFrameOffset/RAPからprerollを選び、対象区間だけを読み直します。絶対位置が検証できないStreamOffsetは利用せず、KLV索引のvalue offsetを使用します。

## 読み込み・メモリ設計と段階的移行

索引と`readEssenceRange()`はファイルサイズではなくKLV packet数と対象区間に比例します。最大単一readは4 MiB、キャッシュは64 MiB、Indexがない場合のprerollは45フレームです。PlayerEngineにはloadGeneration/AbortSignalに加えてseek専用AbortControllerと世代番号があり、古いseekの完了通知を抑止します。

`streaming` モードは区間読み込みと区間デコードが接続済みで、ファイル全体の `ArrayBuffer` 化も全尺デコードも行いません。ピークメモリを決めるのは入力サイズではなく、保持するデコード済みフレーム量です（上記のバイト上限を参照）。一方 `legacy` モードは互換経路として「ファイル全体を `ArrayBuffer` 化 → 全映像・音声デコード」を維持しており、長尺素材ではこちらのピークメモリは解消していません。

Index Tableがない場合はBody Partition/KLVの既知位置、または先頭から順次走査する安全なフォールバックを使用します。未対応形式はDescriptor情報を含む理解可能なエラーにする予定ですが、現エンジンが受理する範囲は下記の既存形式に限られます。

## 対応素材

- MXF OP1a / XDCAM HD422、MPEG-2 Video 422P@High、yuv422p
- 1920×1080、50 Mb/s、30000/1001 fps、top-field-first
- PCM signed 24-bit / 48 kHz / 2 ch（MXFで一般的なBEと、テスト生成時のLE decoderをWASMへ収録）

部分読み込みと区間デコードは `streaming` モードで実装済みです。`legacy` モードは入力全体、全映像フレーム、全尺の音声をメモリに保持するため、長尺素材では `streaming` を指定してください。

## ライセンスとソース提供

libav.jsおよび組み込まれるFFmpeg部分は **GNU LGPL 2.1** です。生成JavaScript内のライセンス表示を削除せず、配布物にはライセンス本文と使用の告知を添付してください。WASM/object codeを配布する場合は、LGPL 2.1が要求する完全な対応ソース（使用したlibav.js/FFmpegソース、変更、ビルドスクリプト・構成）を同じ場所から提供するか、同等の適法な提供方法を用意してください。本リポジトリでは固定tag、`libav/config.json`、build scriptを公開し、受領者が差し替え版を再buildできるようにしています。配布者は自身の配布方法についてライセンス条件を確認してください。

対応ソース: [Yahweasel/libav.js v6.10.9.0](https://github.com/Yahweasel/libav.js/tree/v6.10.9.0) / [LGPL 2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html)

## タイムコード指定ジャンプ

Timecode ComponentからStart Timecode、Rounded Timecode Base、Drop Frame、Duration、Edit Rateを取得し、取得値には`source: "mxf"`を付けます。`mediaFrameToTimecode` / `mediaSecondsToTimecode`と`timecodeToMediaFrame` / `timecodeToMediaSeconds`は整数フレームを基準に、24時間ラップ、29.97/59.94 Drop Frame、素材範囲を検証します。`ref.seekTimecode("10:01:00;02")`は正確なmedia frameへ変換して既存の世代管理付きseekを利用し、`seek(seconds)`との互換性を維持します。Timecode Trackがない場合も再生と秒指定seekは継続します。

Package参照解析は未対応であり、複数Trackでは常にKLV検出順フォールバックを使用して、その理由を`timecodeSelectionReason`へ表示します。Material Package優先は実装していません。

streaming seekの診断には要求/表示frame、RAP開始frame、preroll、Indexまたはsequential fallback、読み込みbytes、経過時間を含めます。Index EntryのRAP/KeyFrameOffset/Flagsはessence range選択に使用します。TemporalOffsetが示す複雑な表示順の完全な追跡、および絶対StreamOffsetをPartitionへ関連付けられないファイルでは、安全なKLV索引位置を利用する制限があります。
