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

/* Apply best-effort autofocus after stream is obtained */
async function applyAutofocus(stream: MediaStream) {
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const caps = (track as any).getCapabilities?.() as Record<string, unknown> | undefined;
    if (!caps) return;

    const constraints: Record<string, unknown> = {};
    // Continuous autofocus
    const focusModes = caps["focusMode"] as string[] | undefined;
    if (focusModes?.includes("continuous")) {
      constraints["focusMode"] = "continuous";
    }
    // Macro/close-range focus distance hint
    if (caps["focusDistance"]) {
      constraints["focusDistance"] = 0.15; // ~15cm — typical barcode distance
    }
    if (Object.keys(constraints).length > 0) {
      await (track as any).applyConstraints({ advanced: [constraints] });
    }
  } catch { /* ignore — not all browsers support this */ }
}

/* Viewfinder region as fractions of the video frame */
const ROI = { x: 0.05, y: 0.20, w: 0.90, h: 0.60 };

/* Require same barcode N times in a row to avoid misreads */
const CONFIRM_HITS = 2;

/* ms to wait after camera starts before scanning (let autofocus settle) */
const WARMUP_MS = 900;

export function CameraScanner({ open, onClose, onDetected }: CameraScannerProps) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef    = useRef<number | null>(null);
  const zxingRef  = useRef<{ stop(): void } | null>(null);
  const lastRef   = useRef<{ code: string; hits: number }>({ code: "", hits: 0 });
  const readyRef  = useRef(false); // true once warmup done

  const [error,     setError]     = useState<string | null>(null);
  const [scanning,  setScanning]  = useState(false);
  const [torch,     setTorch]     = useState(false);
  const [hasTorch,  setHasTorch]  = useState(false);
  const [tapRing,   setTapRing]   = useState<{ x: number; y: number } | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (zxingRef.current) { try { zxingRef.current.stop(); } catch { /**/ } zxingRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
    lastRef.current = { code: "", hits: 0 };
    readyRef.current = false;
  }, []);

  const handleDetected = useCallback((barcode: string) => {
    const trimmed = barcode.trim();
    if (!trimmed || !readyRef.current) return;
    const prev = lastRef.current;
    if (prev.code === trimmed) {
      const hits = prev.hits + 1;
      lastRef.current = { code: trimmed, hits };
      if (hits >= CONFIRM_HITS) {
        stop();
        onDetected(trimmed);
        onClose();
      }
    } else {
      lastRef.current = { code: trimmed, hits: 1 };
    }
  }, [stop, onDetected, onClose]);

  /* Tap-to-focus: show ring + trigger pointFocus if supported */
  const handleVideoTap = useCallback(async (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    setTapRing({ x: relX * 100, y: relY * 100 });
    setTimeout(() => setTapRing(null), 800);

    if (!streamRef.current) return;
    try {
      const track = streamRef.current.getVideoTracks()[0];
      const caps = (track as any).getCapabilities?.() as Record<string, unknown> | undefined;
      if (!caps) return;
      const focusModes = caps["focusMode"] as string[] | undefined;
      if (focusModes?.includes("manual") || focusModes?.includes("single-shot")) {
        await (track as any).applyConstraints({
          advanced: [{ focusMode: "single-shot", pointsOfInterest: [{ x: relX, y: relY }] }],
        });
        // Re-engage continuous after point focus
        setTimeout(async () => {
          try {
            if (focusModes.includes("continuous")) {
              await (track as any).applyConstraints({ advanced: [{ focusMode: "continuous" }] });
            }
          } catch { /**/ }
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
    setError(null);
    setScanning(false);
    setTorch(false);
    setHasTorch(false);
    setTapRing(null);
    lastRef.current = { code: "", hits: 0 };
    readyRef.current = false;

    let cancelled = false;

    async function setupStream(stream: MediaStream) {
      streamRef.current = stream;

      // Check torch support
      try {
        const track = stream.getVideoTracks()[0];
        const caps = (track as any).getCapabilities?.() as Record<string, unknown> | undefined;
        if ((caps as any)?.torch) setHasTorch(true);
      } catch { /**/ }

      // Apply autofocus
      await applyAutofocus(stream);

      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      if (cancelled) { stop(); return; }
      setScanning(true);

      // Warmup: let autofocus settle before accepting reads
      setTimeout(() => { if (!cancelled) readyRef.current = true; }, WARMUP_MS);
    }

    async function startNative() {
      try {
        const formats = await getSupportedFormats();
        // @ts-ignore
        const detector = new BarcodeDetector({ formats });
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        await setupStream(stream);
        if (cancelled) return;

        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

        const tick = async () => {
          if (cancelled) return;
          const video = videoRef.current!;
          if (!video.videoWidth) { rafRef.current = requestAnimationFrame(tick); return; }

          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const sx = Math.round(ROI.x * vw);
          const sy = Math.round(ROI.y * vh);
          const sw = Math.round(ROI.w * vw);
          const sh = Math.round(ROI.h * vh);
          canvas.width  = sw;
          canvas.height = sh;
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

          try {
            // @ts-ignore
            const results: Array<{ rawValue: string }> = await detector.detect(canvas);
            if (results.length > 0 && !cancelled) handleDetected(results[0].rawValue);
          } catch { /**/ }

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
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        await setupStream(stream);
        if (cancelled) return;

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

    if (hasBarcodeDetector()) {
      startNative();
    } else {
      startZxing();
    }

    return () => {
      cancelled = true;
      stop();
      setScanning(false);
    };
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
              <canvas ref={canvasRef} className="hidden" />

              {scanning && (
                <>
                  {/* Dark overlays — top, bottom, left, right of viewfinder */}
                  <div className="absolute inset-x-0 top-0 bg-black/65 pointer-events-none" style={{ bottom: '80%' }} />
                  <div className="absolute inset-x-0 bottom-0 bg-black/65 pointer-events-none" style={{ top: '80%' }} />
                  <div className="absolute bg-black/65 pointer-events-none" style={{ top: '20%', bottom: '20%', left: 0, width: '5%' }} />
                  <div className="absolute bg-black/65 pointer-events-none" style={{ top: '20%', bottom: '20%', right: 0, width: '5%' }} />

                  {/* Viewfinder box — matches ROI */}
                  <div
                    className="absolute pointer-events-none"
                    style={{ top: '20%', bottom: '20%', left: '5%', right: '5%' }}
                  >
                    <span className="absolute top-0 left-0 w-7 h-7 border-t-[3px] border-l-[3px] border-green-400 rounded-tl-sm" />
                    <span className="absolute top-0 right-0 w-7 h-7 border-t-[3px] border-r-[3px] border-green-400 rounded-tr-sm" />
                    <span className="absolute bottom-0 left-0 w-7 h-7 border-b-[3px] border-l-[3px] border-green-400 rounded-bl-sm" />
                    <span className="absolute bottom-0 right-0 w-7 h-7 border-b-[3px] border-r-[3px] border-green-400 rounded-br-sm" />

                    <div
                      className="absolute inset-x-2 h-0.5 bg-green-400/90 shadow-[0_0_8px_3px_rgba(74,222,128,0.7)]"
                      style={{ animation: 'scanline 1.6s ease-in-out infinite' }}
                    />
                  </div>

                  {/* Tap-to-focus ring */}
                  {tapRing && (
                    <div
                      className="absolute pointer-events-none"
                      style={{
                        left: `${tapRing.x}%`,
                        top: `${tapRing.y}%`,
                        transform: 'translate(-50%, -50%)',
                        width: 56,
                        height: 56,
                        borderRadius: '50%',
                        border: '2px solid rgba(255,255,255,0.9)',
                        boxShadow: '0 0 0 1px rgba(0,0,0,0.3)',
                        animation: 'focusring 0.8s ease forwards',
                      }}
                    />
                  )}

                  {/* Torch button */}
                  {hasTorch && (
                    <button
                      onClick={toggleTorch}
                      className={`absolute top-2 right-2 rounded-full p-2 transition-colors z-10 shadow ${
                        torch ? "bg-yellow-400 text-yellow-900" : "bg-black/50 text-white"
                      }`}
                      title={torch ? "Turn torch off" : "Turn torch on"}
                    >
                      {torch ? <ZapOff className="w-5 h-5" /> : <Zap className="w-5 h-5" />}
                    </button>
                  )}

                  {/* Instruction */}
                  <div className="absolute bottom-2 left-0 right-0 text-center pointer-events-none">
                    <span className="text-xs text-green-300 font-medium tracking-wide">
                      Align barcode · tap to focus
                    </span>
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
