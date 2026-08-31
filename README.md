# H422Player

React向けのブラウザ完結型 **MXF OP1a / MPEG-2 422P@HL** プレイヤーです。MPEG-2をWebCodecsへ渡さず、専用構成のlibav.js WebAssemblyでデコードし、yuv422pをRGBAへ変換してCanvas（WebGL）へ表示します。48 kHz / 24-bit PCMはplanar `Float32Array`へ変換してWeb Audio APIで再生します。

## 原因調査

従来コードは`@libav.js/variant-webcodecs` 6.10.9を初期化し、`ff_init_decoder("mpeg2video")`を呼んでいました。しかし同バリアントの構成にはMPEG-2 decoderもMXF demuxerもなく、`Codec not found`はそのためです。本実装はファイルから判定したFFmpegの`codec_id`（MPEG-2 Videoは`2`、24-bit big-endian PCMは`65549`）と`codec_name`をConsoleへ出力し、数値のvideo `codec_id`を`ff_init_decoder`へ渡します。WebCodecsによるMPEG-2対応は前提にしません。

> 現在の軽量KLV readerはOP1a/XDCAM essenceを識別してパケットを取り出します。カスタムWASMには将来libavformatへdemuxを統合できるようMXF demuxerも含めています。

## Windows 11（PowerShell）での起動

```powershell
git clone https://github.com/DaisukeTujita/OpenMxfH422Player.git
Set-Location OpenMxfH422Player
npm install
npm run dev
```

Node.js 20以上を使用してください。初回の`npm run dev`は、バージョンを固定したカスタムlibav.jsをGitHub Releaseから自動取得し、SHA-256を検証して`libav/dist`へ配置します。**Bash、Make、WSL、Emscriptenは不要**です。取得だけを先に行う場合は`npm run setup:libav`を実行できます。

> **公開配布の前提:** `libav/assets.json`はこのリポジトリのGitHub Releaseを参照するため、この手順を認証なしのWindowsで使用するには、Releaseだけでなく**リポジトリ自体をpublicにする必要があります**。privateリポジトリのReleaseは匿名の`fetch()`から取得できません。GitHub tokenをダウンロード処理へ渡す方式は、認証設定なしの`npm install`と`npm run dev`だけで起動する要件を満たさないため採用していません。Release公開workflowもリポジトリがprivateなら公開前に停止します。

リポジトリをprivateのまま運用する場合の推奨方式は、3ファイルだけを別のpublicリポジトリのRelease、または匿名HTTP GETとCORSを許可したpublic object storage/CDNへ配置することです。その公開URLを`libav/assets.json`の`baseUrl`に固定すれば、Windows利用者の追加設定は不要です。組織内ミラーを利用して利用者側で設定する場合は、PowerShellで`$env:LIBAV_ASSET_BASE_URL = "https://example.invalid/libav"`を設定できますが、この場合は環境変数の設定が必要なので「2コマンドだけ」の起動手順にはなりません。

取得に失敗した場合は、ネットワークまたはReleaseの公開状態を確認して`npm run setup:libav`を再実行してください。検証に失敗したファイルは使用されません。続いて、PowerShellから次のコマンドもそのまま実行できます。

```powershell
npm run build
npm run build:example
```

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

## 対応素材

- MXF OP1a / XDCAM HD422、MPEG-2 Video 422P@High、yuv422p
- 1920×1080、50 Mb/s、30000/1001 fps、top-field-first
- PCM signed 24-bit / 48 kHz / 2 ch（MXFで一般的なBEと、テスト生成時のLE decoderをWASMへ収録）

入力全体とデコード済みフレームをメモリに保持するため、長尺素材にはストリーミング実装を推奨します。

## テストMXFと操作確認

Gitにバイナリを含めず、ローカルで5秒のテスト素材を生成します（`ffmpeg`が必要です）。

```sh
npm run sample:mxf
npm run dev --workspace @openmxf/basic-player-example
```

`examples/basic-player`で`public/samples/h422-test.mxf`を選択し、次を確認します。

1. Consoleにvideo/audioの`codec_id`と`codec_name`が表示され、先頭フレームが描画される。
2. **再生**で映像と1 kHz音声が進み、**一時停止**で両方が止まる。
3. **停止**で0秒へ戻り、シークバーの前後移動後に対応フレームと音声位置から再開する。

自動テストはBER readerに加えて、yuv422p→RGBAと24-bit PCM→Web Audio float変換を検証します。

## ライセンスとソース提供

libav.jsおよび組み込まれるFFmpeg部分は **GNU LGPL 2.1** です。生成JavaScript内のライセンス表示を削除せず、配布物にはライセンス本文と使用の告知を添付してください。WASM/object codeを配布する場合は、LGPL 2.1が要求する完全な対応ソース（使用したlibav.js/FFmpegソース、変更、ビルドスクリプト・構成）を同じ場所から提供するか、同等の適法な提供方法を用意してください。本リポジトリでは固定tag、`libav/config.json`、build scriptを公開し、受領者が差し替え版を再buildできるようにしています。配布者は自身の配布方法についてライセンス条件を確認してください。

対応ソース: [Yahweasel/libav.js v6.10.9.0](https://github.com/Yahweasel/libav.js/tree/v6.10.9.0) / [LGPL 2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html)
