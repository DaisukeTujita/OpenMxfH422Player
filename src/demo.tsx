import { useState } from "react";
import { createRoot } from "react-dom/client";
import { H422Player } from "./H422Player";

function Demo() {
  const [file, setFile] = useState<File>();
  return <main style={{fontFamily:"sans-serif",maxWidth:960,margin:"2rem auto"}}>
    <h1>H422Player</h1>
    <p>OP1a / XDCAM HD422 MXFを選択してください。ファイルはサーバーへ送信されません。</p>
    <input type="file" accept=".mxf,application/mxf" onChange={(event)=>setFile(event.target.files?.[0])}/>
    {file && <div style={{marginTop:16}}><H422Player src={file} libavBase="/libav" controls onError={console.error}/></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Demo/>);
