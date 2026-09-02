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

PlayerEngine の実験的な `streaming` モードはこの索引と区間取得APIを使用します。
既定の `legacy` は既存OP1a/XDCAM HD422との互換性を優先し、従来どおり全体を読み込みます。

索引処理はEssence Valueを個別の`Uint8Array`として生成しないため、ピークメモリを抑えます。
ただし`FileRandomAccessReader`は既定で1 MiB単位のアライン済みチャンクを読むため、KLV間隔が
チャンクより短いファイルでは、ヘッダー走査だけでも物理I/Oがファイルの大部分に及ぶ可能性が
あります。「常にファイル全体より少ないI/O」は保証しません。HTTP Range向けの小さなヘッダー
キャッシュ／Reader設計とPlayerEngineの区間デコード接続は次段階の対象です。

React向けのブラウザ完結型 **MXF OP1a / MPEG-2 422P@HL** プレイヤーです。MPEG-2をWebCodecsへ渡さず、専用構成のlibav.js WebAssemblyでデコードし、yuv422pをRGBAへ変換してCanvas（WebGL）へ表示します。48 kHz / 24-bit PCMはplanar `Float32Array`へ変換してWeb Audio APIで再生します。

## Windows 11（PowerShell）での起動

```powershell
git clone https://github.com/DaisukeTujita/OpenMxfH422Player.git
Set-Location OpenMxfH422Player
npm install
npm run dev
```

Node.js 20以上を使用してください。初回の`npm run dev`は、バージョンを固定したカスタムlibav.jsをGitHub Releaseから自動取得し、SHA-256を検証して`libav/dist`へ配置します。**Bash、Make、WSL、Emscriptenは不要**です。取得だけを先に行う場合は`npm run setup:libav`を実行できます。

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

`mode` は `"legacy" | "streaming"` で、既定値は安全な `legacy` です。streaming では
`readWhole()` を呼ばず、1回約3秒の区間を、キューが4秒先まで満たされるよう取得します。
残量2秒未満で補充を開始し、表示済みから
1秒より古いRGBAフレームを破棄し、seek時は旧要求をAbortしてseek先付近だけを再取得します。
`ref.getDiagnostics()` と `onDiagnostics` からReader I/O、キャッシュ、キュー、世代を確認できます。

**現時点の制約:** streaming のPCM区間スケジューリングは未対応で、
streamingでは音声を再生しません。映像が枯渇した場合は再生時計を停止してbufferingを通知し、補充後に同じ位置から再開します。音声を含む完走確認にはlegacyを使用してください。Index Tableの
`StreamOffset`はBodySIDのEssence Container stream先頭を基準とする相対値であり、Partitionの
絶対位置へ単純加算できません。本実装は推測による直接変換をせず、安全なKLVヘッダー順次索引へ
フォールバックします。このためEssence Valueのメモリ化は避けますが、初回の物理I/O時間は
ファイル長に比例し得ます。

入力が `File` / `Blob` の場合は `Blob.slice()` により必要な物理範囲だけを読みます。一方、文字列URLは
現在 `fetch(url).blob()` でファイル全体をダウンロードした後にReaderを作成します。HTTP Rangeによる
ネットワークストリーミングは未対応であり、URL指定時の通信量は削減されません。

`PlayerInfo.audioChannels` は「現在再生可能な音声チャンネル数」です。このため映像のみのstreamingでは
MXF内に音声Essenceが存在しても `0` を返し、音声Essence Value自体も読み込みません。

`src`には`File`、`Blob`、またはCORSを許可したURLを指定できます。`ref`から`play()`、`pause()`、`seek(seconds)`、`currentTime`、`duration`を利用できます。音声はブラウザのautoplay policyにより通常ユーザー操作後に開始します。シーク時はAudioBufferSourceNodeを指定位置から作り直します。

追加コールバックの `onMediaInfo` はMXFから実際に取得できた構造情報を返し、未取得フィールドは `undefined` のままです。`onTimecode` は現在位置のSMPTEタイムコード、Timecode Trackがない場合は `null` を返します。`onSeekingChange` はシーク処理の開始・終了を通知します。`onBufferingChange` はstreaming映像のバッファ枯渇・復旧、およびseek中の準備状態を重複なく通知します。

## MXF解析

解析器はPartition PackのOperational Pattern、Header Metadata内のDescriptor/Track系Local Set、およびIndex Table SegmentをEssenceデコードとは分離して走査します。現在、メタデータから次の値を取得できます。

- Operational Pattern、Essence Container UL
- Stored Width / Stored Height、Aspect Ratio
- Track Edit Rate、Descriptor Duration
- Audio Sampling Rate、Channel Count、Quantization Bits
- Timecode ComponentのStart Timecode、Rounded Timecode Base、Drop Frame、Duration
- Index Edit Rate、Index Start Position、Index Duration、Edit Unit Byte Count
- Index EntryのStream Offset、Key Frame Offset、Temporal Offset、Flags

Stream OffsetはJavaScriptの安全な整数範囲に丸めず `bigint` で保持します。異なるMXF生成器がPrimer Packで動的Local Tagを割り当てるケースの完全対応、Codec/Pixel Format ULの網羅的な名称解決、Package参照を辿ったMaterial/Sourceの優先順位付けは今後の拡張対象です。解析できない値に1920×1080等の固定値を代入することはありません。一方、既存デコード経路は従来互換の対象形式に限り、libav codec ID、30000/1001 fps、48 kHz、2 chを引き続き利用します。このフォールバックは再生エンジンの区間デコード化まで既存素材を再生可能に保つための暫定措置です。

## タイムコード表示

サンプル画面はミリ秒単位の再生位置とMXFタイムコードを併記します。Non-Drop Frameに加え、29.97 fps（base 30）と59.94 fps（base 60）のDrop Frame番号を扱い、区切りはDrop Frameでは `;`、Non-Dropでは `:` です。開始タイムコードへ現在の再生フレームを加算し、24時間でラップします。利用可能なTimecode Trackがない場合は「タイムコードなし」と表示し、再生自体は継続します。

### 複数Timecode Trackの選択規則

現段階ではMaterial PackageとSource Packageの参照関係を完全には解決していません。複数のTimecode Trackが見つかった場合は、**MXF内のKLV検出順で最初に現れ、Edit Rateの分子・分母がともに正数であるTrack**を表示に使用します。検出数を`console.debug`へ、複数検出の警告を`console.warn`へ、選択したTrackのStart Timecode（frame値）・Edit Rate・Drop Frameを`console.info`へ出力します。この規則は暫定的なもので、Package参照を解決できるようになった段階でMaterial Package優先へ置き換える予定です。

サンプルの「MXF解析情報」にはOperational Pattern、Essence Container、解像度、Edit Rate、Aspect Ratio、音声Sample Rate、チャンネル数、Quantization Bits、Timecode Track数、選択された開始タイムコード、Drop Frame、Index Table数とEntry総数を表示します。メタデータから取得できなかった項目を再生用固定値で補完せず、「未取得」と表示します。

## Indexとシーク

`findSeekPoint()` は目的Edit Unit以前のRandom Access Pointを選択します。Index Entryがなく固定Edit Unit Byte Countがある場合はオフセットを算出し、Index Tableがない・壊れている場合は `source: "sequential-fallback"` として先頭からの順次走査を明示します。streamingシークはIndex EntryのKeyFrameOffset/RAPからprerollを選び、対象区間だけを読み直します。絶対位置が検証できないStreamOffsetは利用せず、KLV索引のvalue offsetを使用します。

## 読み込み・メモリ設計と段階的移行

索引と`readEssenceRange()`はファイルサイズではなくKLV packet数と対象区間に比例します。最大単一readは4 MiB、キャッシュは64 MiB、Indexがない場合のprerollは45フレームです。PlayerEngineにはloadGeneration/AbortSignalに加えてseek専用AbortControllerと世代番号があり、古いseekの完了通知を抑止します。ただし現在の再生デコード互換経路は依然「ファイル全体を `ArrayBuffer` 化 → 全映像・音声デコード」で、長尺素材のピークメモリはまだ解消していません。

Index Tableがない場合はBody Partition/KLVの既知位置、または先頭から順次走査する安全なフォールバックを使用する予定です。未対応形式はDescriptor情報を含む理解可能なエラーにする予定ですが、現エンジンが受理する範囲は下記の既存形式に限られます。

## 対応素材

- MXF OP1a / XDCAM HD422、MPEG-2 Video 422P@High、yuv422p
- 1920×1080、50 Mb/s、30000/1001 fps、top-field-first
- PCM signed 24-bit / 48 kHz / 2 ch（MXFで一般的なBEと、テスト生成時のLE decoderをWASMへ収録）

入力全体、RGBA化した全映像フレーム、全尺の音声をメモリに保持するため、現在は長尺素材の再生に負荷がかかります。部分読み込み・区間デコードは上記の後続段階で実装します。

## ライセンスとソース提供

libav.jsおよび組み込まれるFFmpeg部分は **GNU LGPL 2.1** です。生成JavaScript内のライセンス表示を削除せず、配布物にはライセンス本文と使用の告知を添付してください。WASM/object codeを配布する場合は、LGPL 2.1が要求する完全な対応ソース（使用したlibav.js/FFmpegソース、変更、ビルドスクリプト・構成）を同じ場所から提供するか、同等の適法な提供方法を用意してください。本リポジトリでは固定tag、`libav/config.json`、build scriptを公開し、受領者が差し替え版を再buildできるようにしています。配布者は自身の配布方法についてライセンス条件を確認してください。

対応ソース: [Yahweasel/libav.js v6.10.9.0](https://github.com/Yahweasel/libav.js/tree/v6.10.9.0) / [LGPL 2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html)
