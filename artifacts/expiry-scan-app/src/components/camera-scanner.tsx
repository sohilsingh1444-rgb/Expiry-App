import { useEffect, useRef, useState, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Camera, Zap, ZapOff } from "lucide-react";

interface CameraScannerProps {
  open: boolean;
  onClose: () => void;
  onDetected: (barcode: string) => void;
}

function hasBarcodeDetector(): boolean {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

async function getSupportedFormats(): Promise<string[]> {
  try {
    // @ts-ignore
    const formats: string[] = await BarcodeDetector.getSupportedFormats();
    if (formats && formats.length > 0) return formats;
  } catch { /* ignore */ }
  return [
    "ean_13", "ean_8", "upc_a", "upc_e",
    "code_128", "code_39", "code_93", "itf",
    "codabar", "aztec", "pdf417", "qr_code", "data_matrix",
  ];
}

/** Laplacian variance on a tiny downsampled canvas — fast sharpness metric.
 *  Returns a value ~0 (blurry) to ~500+ (sharp). */
function computeSharpness(data: Uint8ClampedArray, w: number, h: number): number {
  let sum = 0, n = 0;
  // stride=2 → check every other pixel (still fast on 160×90)
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = (y * w + x) * 4;
      const g  = (data[i] + data[i+1] + data[i+2]) / 3;
      const u  = ((data[((y-1)*w+x)*4]) + data[((y-1)*w+x)*4+1] + data[((y-1)*w+x)*4+2]) / 3;
      const d  = ((data[((y+1)*w+x)*4]) + data[((y+1)*w+x)*4+1] + data[((y+1)*w+x)*4+2]) / 3;
      const l  = ((data[(y*w+x-1)*4]) + data[(y*w+x-1)*4+1] + data[(y*w+x-1)*4+2]) / 3;
      const r  = ((data[(y*w+x+1)*4]) + data[(y*w+x+1)*4+1] + data[(y*w+x+1)*4+2]) / 3;
      const lap = 4*g - u - d - l - r;
      sum += lap * lap;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Viewfinder ROI (fraction of video frame). Keep in sync with the CSS overlays below. */
const ROI = { x: 0.05, y: 0.20, w: 0.90, h: 0.60 };

/** Confirm same barcode N times to avoid misreads */
const CONFIRM_HITS = 2;
/** Sharpness score must exceed this to attempt barcode detection */
const SHARP_THRESHOLD = 40;
/** Small canvas used only for cheap sharpness check */
const SHARP_W = 160, SHARP_H = 90;

export function CameraScanner({ open, onClose, onDetected }: CameraScannerProps) {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const sharpRef    = useRef<HTMLCanvasElement>(null);   // tiny, offscreen, for sharpness
  const streamRef   = useRef<MediaStream | null>(null);
  const rafRef      = useRef<number | null>(null);
  const zxingRef    = useRef<{ stop(): void } | null>(null);
  const lastRef     = useRef<{ code: string; hits: number }>({ code: "", hits: 0 });

  const [error,    setError]    = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [focused,  setFocused]  = useState(false);   // true when frame is sharp
  const [torch,    setTorch]    = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [tapRing,  setTapRing]  = useState<{ x: number; y: number } | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (zxingRef.current) { try { zxingRef.current.stop(); } catch { /**/ } zxingRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
    lastRef.current = { code: "", hits: 0 };
  }, []);

  const handleDetected = useCallback((barcode: string) => {
    const trimmed = barcode.trim();
    if (!trimmed) return;
    const prev = lastRef.current;
    if (prev.code === trimmed) {
      const hits = prev.hits + 1;
      lastRef.current = { code: trimmed, hits };
      if (hits >= CONFIRM_HITS) { stop(); onDetected(trimmed); onClose(); }
    } else {
      lastRef.current = { code: trimmed, hits: 1 };
    }
  }, [stop, onDetected, onClose]);

  /* Tap-to-focus: visual ring + pointsOfInterest if supported */
  const handleVideoTap = useCallback(async (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    setTapRing({ x: relX * 100, y: relY * 100 });
    setTimeout(() => setTapRing(null), 900);
    if (!streamRef.current) return;
    try {
      const track = streamRef.current.getVideoTracks()[0];
      const caps = (track as any).getCapabilities?.() as Record<string, unknown> | undefined;
      const modes = caps?.["focusMode"] as string[] | undefined;
      if (modes?.includes("single-shot")) {
        await (track as any).applyConstraints({ advanced: [{ focusMode: "single-shot", pointsOfInterest: [{ x: relX, y: relY }] }] });
        setTimeout(async () => {
          try { if (modes.includes("continuous")) await (track as any).applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch { /**/ }
        }, 700);
      }
    } catch { /**/ }
  }, []);

  const toggleTorch = useCallback(async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    try {
      const next = !torch;
      await (track as any).applyConstraints({ advanced: [{ torch: next }] });
      setTorch(next);
    } catch { /**/ }
  }, [torch]);

  useEffect(() => {
    if (!open) return;
    setError(null); setScanning(false); setFocused(false);
    setTorch(false); setHasTorch(false); setTapRing(null);
    lastRef.current = { code: "", hits: 0 };
    let cancelled = false;

    async function setupStream(stream: MediaStream) {
      streamRef.current = stream;
      try {
        const track = stream.getVideoTracks()[0];
        const caps = (track as any).getCapabilities?.() as Record<string, unknown> | undefined;
        if ((caps as any)?.torch) setHasTorch(true);
        // Best-effort continuous autofocus
        const modes = caps?.["focusMode"] as string[] | undefined;
        if (modes?.includes("continuous")) {
          await (track as any).applyConstraints({ advanced: [{ focusMode: "continuous" }] });
        }
      } catch { /**/ }
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
    }

    async function startNative() {
      try {
        const formats = await getSupportedFormats();
        // @ts-ignore
        const detector = new BarcodeDetector({ formats });
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        await setupStream(stream);
        if (cancelled) { stop(); return; }
        setScanning(true);

        const canvas  = canvasRef.current!;
        const ctx     = canvas.getContext("2d", { willReadFrequently: true })!;
        const sharp   = sharpRef.current!;
        sharp.width   = SHARP_W;
        sharp.height  = SHARP_H;
        const sharpCtx = sharp.getContext("2d", { willReadFrequently: true })!;

        const tick = async () => {
          if (cancelled) return;
          const video = videoRef.current!;
          if (!video.videoWidth) { rafRef.current = requestAnimationFrame(tick); return; }

          const vw = video.videoWidth, vh = video.videoHeight;
          const sx = Math.round(ROI.x * vw), sy = Math.round(ROI.y * vh);
          const sw = Math.round(ROI.w * vw), sh = Math.round(ROI.h * vh);

          // 1. Cheap sharpness check on tiny canvas
          sharpCtx.drawImage(video, sx, sy, sw, sh, 0, 0, SHARP_W, SHARP_H);
          const imgData = sharpCtx.getImageData(0, 0, SHARP_W, SHARP_H);
          const score = computeSharpness(imgData.data, SHARP_W, SHARP_H);
          const isSharp = score >= SHARP_THRESHOLD;
          setFocused(isSharp);

          // 2. Only scan when the frame is actually focused
          if (isSharp) {
            canvas.width = sw; canvas.height = sh;
            ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
            try {
              // @ts-ignore
              const results: Array<{ rawValue: string }> = await detector.detect(canvas);
              if (results.length > 0 && !cancelled) handleDetected(results[0].rawValue);
            } catch { /**/ }
          }

          if (!cancelled) rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        if (!cancelled) startZxing(e);
      }
    }

    async function startZxing(previousError?: unknown) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        await setupStream(stream);
        if (cancelled) { stop(); return; }
        setScanning(true);

        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromStream(stream, videoRef.current!, (result, _err, ctrl) => {
          if (cancelled) { ctrl?.stop(); return; }
          if (result) handleDetected(result.getText());
        });
        zxingRef.current = controls;
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          const prev = previousError instanceof Error ? previousError.message : undefined;
          const detail = prev && prev !== msg ? ` (${prev})` : "";
          if (msg.toLowerCase().includes("permission") || msg.toLowerCase().includes("denied")) {
            setError("Camera access was denied. Please allow camera permission and try again.");
          } else {
            setError("Could not access camera." + detail);
          }
        }
      }
    }

    if (hasBarcodeDetector()) { startNative(); } else { startZxing(); }

    return () => { cancelled = true; stop(); setScanning(false); setFocused(false); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-sm p-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Camera className="w-4 h-4" />
            Scan Barcode with Camera
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {error ? (
            <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-center text-sm text-red-700">
              {error}
            </div>
          ) : (
            <div
              className="relative overflow-hidden rounded-xl bg-black aspect-video shadow-inner cursor-crosshair"
              onPointerDown={scanning ? handleVideoTap : undefined}
            >
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
              {/* Main scan canvas (full ROI res) */}
              <canvas ref={canvasRef} className="hidden" />
              {/* Tiny sharpness-check canvas */}
              <canvas ref={sharpRef} className="hidden" />

              {scanning && (
                <>
                  {/* Dark overlays — must match ROI constants (top 20%, bottom 20%, sides 5%) */}
                  <div className="absolute inset-x-0 top-0 bg-black/65 pointer-events-none" style={{ height: '20%' }} />
                  <div className="absolute inset-x-0 bottom-0 bg-black/65 pointer-events-none" style={{ height: '20%' }} />
                  <div className="absolute bg-black/65 pointer-events-none" style={{ top: '20%', bottom: '20%', left: 0, width: '5%' }} />
                  <div className="absolute bg-black/65 pointer-events-none" style={{ top: '20%', bottom: '20%', right: 0, width: '5%' }} />

                  {/* Viewfinder box */}
                  <div
                    className="absolute pointer-events-none"
                    style={{ top: '20%', bottom: '20%', left: '5%', right: '5%' }}
                  >
                    {/* Corner brackets — color shows focus state */}
                    {(["tl","tr","bl","br"] as const).map(c => (
                      <span
                        key={c}
                        className={`absolute transition-colors duration-300 ${focused ? "border-green-400" : "border-amber-400"} ${
                          c === "tl" ? "top-0 left-0 border-t-[3px] border-l-[3px] rounded-tl-sm" :
                          c === "tr" ? "top-0 right-0 border-t-[3px] border-r-[3px] rounded-tr-sm" :
                          c === "bl" ? "bottom-0 left-0 border-b-[3px] border-l-[3px] rounded-bl-sm" :
                                       "bottom-0 right-0 border-b-[3px] border-r-[3px] rounded-br-sm"
                        } w-7 h-7`}
                      />
                    ))}

                    {/* Scan line — only visible when focused */}
                    {focused && (
                      <div
                        className="absolute inset-x-2 h-0.5 bg-green-400/90 shadow-[0_0_8px_3px_rgba(74,222,128,0.7)]"
                        style={{ animation: 'scanline 1.6s ease-in-out infinite' }}
                      />
                    )}
                  </div>

                  {/* Tap-to-focus ring */}
                  {tapRing && (
                    <div
                      className="absolute pointer-events-none"
                      style={{
                        left: `${tapRing.x}%`, top: `${tapRing.y}%`,
                        transform: 'translate(-50%, -50%)',
                        width: 56, height: 56, borderRadius: '50%',
                        border: '2px solid rgba(255,255,255,0.9)',
                        boxShadow: '0 0 0 1px rgba(0,0,0,0.3)',
                        animation: 'focusring 0.9s ease forwards',
                      }}
                    />
                  )}

                  {/* Torch button */}
                  {hasTorch && (
                    <button
                      onClick={toggleTorch}
                      className={`absolute top-2 right-2 rounded-full p-2 z-10 shadow transition-colors ${
                        torch ? "bg-yellow-400 text-yellow-900" : "bg-black/50 text-white"
                      }`}
                      title={torch ? "Turn torch off" : "Turn torch on"}
                    >
                      {torch ? <ZapOff className="w-5 h-5" /> : <Zap className="w-5 h-5" />}
                    </button>
                  )}

                  {/* Focus status indicator */}
                  <div className="absolute bottom-2 left-0 right-0 text-center pointer-events-none">
                    {focused ? (
                      <span className="text-xs text-green-300 font-medium tracking-wide">
                        ● Ready — scanning…
                      </span>
                    ) : (
                      <span className="text-xs text-amber-300 font-medium tracking-wide animate-pulse">
                        ◌ Focusing… hold steady or tap
                      </span>
                    )}
                  </div>
                </>
              )}

              {!scanning && !error && (
                <div className="absolute inset-0 flex items-center justify-center text-white text-sm">
                  Starting camera…
                </div>
              )}
            </div>
          )}

          <Button variant="outline" className="w-full" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
