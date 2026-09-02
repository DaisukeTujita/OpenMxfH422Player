# H422Player

## メタデータの部分読み込み（PR 2）

MXFメタデータ、Partition Pack、Random Index Pack、Index Table Segmentの調査は
`RandomAccessReader`を使用します。ローカルの`File`/`Blob`は`Blob.slice()`で
アラインされた範囲だけを読み、既定値は1 MiBチャンク、64 MiBのLRUキャッシュ、
単一`read()`最大4 MiBです。同一チャンクの同時要求共有、AbortSignal、統計取得に
対応し、各値は`FileRandomAccessReader`のオプションで変更できます。RIPがない、
または壊れている場合は、KLV ValueをLengthで読み飛ばす安全な順次走査を行います。
有効なRIPがある場合は全域を順次走査せず、RIPが示す各Partition Packと、
Partition Pack直後の`HeaderByteCount`および`IndexByteCount`範囲だけを解析します。

これは**ストリーミング再生対応ではありません**。映像・音声デコードの互換経路は
メタデータ調査後にまだファイル全体の連続バッファを作るため、プレイヤー全体の
メモリ問題は未解消です。次のPR 3でEssenceデコードとシークをReaderへ接続します。

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
  return <H422Player src={file} libavBase="/libav" controls onError={console.error} />;
}
```

`src`には`File`、`Blob`、またはCORSを許可したURLを指定できます。`ref`から`play()`、`pause()`、`seek(seconds)`、`currentTime`、`duration`を利用できます。音声はブラウザのautoplay policyにより通常ユーザー操作後に開始します。シーク時はAudioBufferSourceNodeを指定位置から作り直します。

追加コールバックの `onMediaInfo` はMXFから実際に取得できた構造情報を返し、未取得フィールドは `undefined` のままです。`onTimecode` は現在位置のSMPTEタイムコード、Timecode Trackがない場合は `null` を返します。`onSeekingChange` はシーク処理の開始・終了を通知します。`onBufferingChange` は部分読み込みを導入する次段階とのAPI互換用で、現バージョンではまだ通知されません。

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

`findSeekPoint()` は目的Edit Unit以前のRandom Access Pointを選択します。Index Entryがなく固定Edit Unit Byte Countがある場合はオフセットを算出し、Index Tableがない・壊れている場合は `source: "sequential-fallback"` として先頭からの順次走査を明示します。現在のプレイヤー本体は全フレームが既にデコード済みの従来シークを使用しており、Index位置からの部分読み込みとデコーダ再開は後続段階で統合します。

## 読み込み・メモリ設計と段階的移行

現時点のフローは「ファイル全体を `ArrayBuffer` 化 → KLV走査 → 全映像・音声デコード」です。この解析PRだけでは大容量ファイルのメモリ問題はまだ解消していません。次の段階で `RandomAccessReader`（`File.slice()`、AbortSignal、重複要求抑止、LRUチャンクキャッシュ）を導入し、その後に固定長デコードキューと世代付きシークへ切り替えます。予定する既定値は、最大単一read 4 MiB、キャッシュ64 MiB、映像先読み4秒、音声先読み2秒です。シーク時には旧世代のpacket、表示待ちframe、音声bufferを破棄し、ファイルサイズに比例してメモリが増えない構成にします。これらの上限は**設計予定値であり、現実装の保証値ではありません**。

Index Tableがない場合はBody Partition/KLVの既知位置、または先頭から順次走査する安全なフォールバックを使用する予定です。未対応形式はDescriptor情報を含む理解可能なエラーにする予定ですが、現エンジンが受理する範囲は下記の既存形式に限られます。

## 対応素材

- MXF OP1a / XDCAM HD422、MPEG-2 Video 422P@High、yuv422p
- 1920×1080、50 Mb/s、30000/1001 fps、top-field-first
- PCM signed 24-bit / 48 kHz / 2 ch（MXFで一般的なBEと、テスト生成時のLE decoderをWASMへ収録）

入力全体、RGBA化した全映像フレーム、全尺の音声をメモリに保持するため、現在は長尺素材の再生に負荷がかかります。部分読み込み・区間デコードは上記の後続段階で実装します。

## ライセンスとソース提供

libav.jsおよび組み込まれるFFmpeg部分は **GNU LGPL 2.1** です。生成JavaScript内のライセンス表示を削除せず、配布物にはライセンス本文と使用の告知を添付してください。WASM/object codeを配布する場合は、LGPL 2.1が要求する完全な対応ソース（使用したlibav.js/FFmpegソース、変更、ビルドスクリプト・構成）を同じ場所から提供するか、同等の適法な提供方法を用意してください。本リポジトリでは固定tag、`libav/config.json`、build scriptを公開し、受領者が差し替え版を再buildできるようにしています。配布者は自身の配布方法についてライセンス条件を確認してください。

対応ソース: [Yahweasel/libav.js v6.10.9.0](https://github.com/Yahweasel/libav.js/tree/v6.10.9.0) / [LGPL 2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html)
