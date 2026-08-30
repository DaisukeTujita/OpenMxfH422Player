import { spawnSync } from "node:child_process";
import { platform } from "node:os";

if (platform() === "win32") {
  console.error("このコマンドは配布アセット作成者向けです。Windows 利用者は npm run setup:libav を実行してください（Bash/Make/WSL は不要です）。");
  process.exit(1);
}
const result = spawnSync("bash", ["scripts/build-libav-h422.sh"], { stdio: "inherit" });
process.exit(result.status ?? 1);
