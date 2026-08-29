# H422Player

React向けのブラウザ完結型 **OP1a / XDCAM HD422 MXF** プレイヤーです。MXFを変換せずにKLVを解析し、MPEG-2 50 Mb/s映像をlibav.js（WebAssembly）でデコード、WebGLで表示します。48 kHz / 16-bit big-endian PCMをWeb Audio APIで再生し、音声クロックを基準に同期します。

## インストール

```sh
npm install @openmxf/h422-player @libav.js/variant-webcodecs
```

libav.jsのWASM/workerアセットはGitに含めません。`npm install`後、開発時は`npm run dev`がnpmパッケージから`public/libav`へ、本番ライブラリの`npm run build`は`dist/libav`へ必要なファイルをコピーします。独自の配置先を使う場合は`node scripts/copy-libav-assets.mjs <公開ディレクトリ>`を実行し、`libavBase`をその公開URLに設定してください。

## React

```tsx
import { H422Player } from "@openmxf/h422-player";

export default function Preview({ file }: { file: File }) {
  return <H422Player src={file} libavBase="/libav" controls onError={console.error} />;
}
```

`src`には`File`、`Blob`、またはURLを指定できます。URLの場合はサーバー側のCORS設定が必要です。`ref`から`play()`、`pause()`、`seek(seconds)`、`currentTime`、`duration`を利用できます。

## 対応範囲と注意

- Operational PatternはOP1a、映像はXDCAM HD422 MPEG-2に限定しています。その他は明示的なエラーになります。
- 音声はXDCAMで一般的な48 kHz、16-bit big-endian、2チャンネルの非圧縮PCMを扱います。
- 入力全体とデコード済みフレームをメモリに保持する初期実装です。長尺素材にはストリーミング実装を推奨します。
- 再生開始はブラウザのautoplayポリシーに従い、通常はユーザー操作が必要です。

## ローカルMXFサンプル

MXFはバイナリのためGit管理しません。テスト素材は`public/samples/example.mxf`のようにローカル配置してください（このディレクトリのMXFは`.gitignore`対象です）。Vite開発サーバーでは`src="/samples/example.mxf"`として参照できます。素材のライセンスと機密性を確認し、共有が必要な場合はGit LFSやアクセス制御されたオブジェクトストレージを利用してください。

## サンプルWebアプリ

`examples/basic-player`に、ローカルのMXFファイルを選択して本ライブラリの公開APIを試せるReact + TypeScript製アプリがあります。ライブラリのソースはコピーせず、Viteのaliasでこのリポジトリの`src/index.ts`を参照します。

リポジトリのルートで次のコマンドを実行してください。

```sh
npm install
npm run dev --workspace @openmxf/basic-player-example
```

表示されたURL（通常は`http://localhost:5173`）をブラウザで開き、手元のOP1a / XDCAM HD422 MXFを選択します。MXFファイル自体をリポジトリへ追加する必要はありません。プロダクションビルドは`npm run build:example`で確認できます。
