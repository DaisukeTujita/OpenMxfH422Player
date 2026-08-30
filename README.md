# H422Player

React向けのブラウザ完結型 **MXF OP1a / MPEG-2 422P@HL** プレイヤーです。MPEG-2をWebCodecsへ渡さず、専用構成のlibav.js WebAssemblyでデコードし、yuv422pをRGBAへ変換してCanvas（WebGL）へ表示します。48 kHz / 24-bit PCMはplanar `Float32Array`へ変換してWeb Audio APIで再生します。

## 原因調査

従来コードは`@libav.js/variant-webcodecs` 6.10.9を初期化し、`ff_init_decoder("mpeg2video")`を呼んでいました。しかし同バリアントの構成にはMPEG-2 decoderもMXF demuxerもなく、`Codec not found`はそのためです。本実装はファイルから判定したFFmpegの`codec_id`（MPEG-2 Videoは`2`、24-bit big-endian PCMは`65549`）と`codec_name`をConsoleへ出力し、数値のvideo `codec_id`を`ff_init_decoder`へ渡します。WebCodecsによるMPEG-2対応は前提にしません。

> 現在の軽量KLV readerはOP1a/XDCAM essenceを識別してパケットを取り出します。カスタムWASMには将来libavformatへdemuxを統合できるようMXF demuxerも含めています。

## インストールとカスタムWASM

```sh
npm install
npm run build:libav
npm run dev
```

`libav/config.json`が再現可能な最小構成です。MXF demuxer、MPEG-2 Video parser/decoder、signed 24-bit PCM decoder（BE/LE）、swscale、swresampleを含みます。`scripts/build-libav-h422.sh`はlibav.js v6.10.9を取得して`h422` variantを生成します。生成物は`libav/dist`へ置かれ、`copy-libav-assets.mjs`が開発時は`public/libav`、ライブラリbuild時は`dist/libav`へコピーします。WASMバイナリはGitには登録しません。

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

対応ソース: [Yahweasel/libav.js v6.10.9](https://github.com/Yahweasel/libav.js/tree/v6.10.9) / [LGPL 2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html)
