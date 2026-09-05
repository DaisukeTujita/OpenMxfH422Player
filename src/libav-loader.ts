export type LibAV = Record<string, any>;

export async function loadCustomLibAV(base: string): Promise<LibAV> {
  const normalizedBase = base.replace(/\/$/, "");
  const url = `${normalizedBase}/libav-h422.mjs`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch custom libav.js frontend: ${url} (${reason})`, { cause: error });
  }
  if (!response.ok) {
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    throw new Error(`Failed to fetch custom libav.js frontend: ${url} (${status})`);
  }

  const source = await response.text();
  const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    // Import the fetched deployment asset indirectly so bundlers do not resolve publicDir at build time.
    const module = await import(/* @vite-ignore */ moduleUrl) as { default?: { LibAV(options: object): Promise<unknown> }; LibAV?: (options: object) => Promise<unknown> };
    const factory = module.default?.LibAV ?? module.LibAV;
    if (!factory) throw new Error(`Invalid custom libav.js frontend: ${url}`);
    // The decode Worker already keeps libav.js off the main thread, so libav.js must not spawn a
    // nested worker of its own: every decoded frame would be structured-cloned across that extra
    // hop. Its in-process path resolves the WASM module against the frontend's own URL, which is a
    // blob: here, so the asset directory has to be absolute for that resolution to land.
    return await factory({ base: new URL(normalizedBase, self.location.href).href, noworker: true }) as LibAV;
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}
