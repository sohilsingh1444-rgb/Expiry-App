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
    "codabar", "code_39_mod_43", "aztec",
    "pdf417", "qr_code", "data_matrix",
  ];
}

/* Viewfinder region as fractions of the video frame.
   Must match the CSS overlay values below exactly. */
const ROI = { x: 0.10, y: 0.25, w: 0.80, h: 0.50 };

/* Number of consecutive identical reads before we accept */
const CONFIRM_HITS = 2;

export function CameraScanner({ open, onClose, onDetected }: CameraScannerProps) {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const rafRef      = useRef<number | null>(null);
  const zxingRef    = useRef<{ stop(): void } | null>(null);
  const lastRef     = useRef<{ code: string; hits: number }>({ code: "", hits: 0 });

  const [error,    setError]    = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [torch,    setTorch]    = useState(false);
  const [hasTorch, setHasTorch] = useState(false);

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
      if (hits >= CONFIRM_HITS) {
        stop();
        onDetected(trimmed);
        onClose();
      }
    } else {
      lastRef.current = { code: trimmed, hits: 1 };
    }
  }, [stop, onDetected, onClose]);

  /* Toggle torch */
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
    lastRef.current = { code: "", hits: 0 };

    let cancelled = false;

    async function checkTorch(stream: MediaStream) {
      try {
        const track = stream.getVideoTracks()[0];
        const caps = (track as any).getCapabilities?.();
        if (caps?.torch) setHasTorch(true);
      } catch { /**/ }
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

        streamRef.current = stream;
        checkTorch(stream);
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        if (cancelled) { stop(); return; }
        setScanning(true);

        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

        const tick = async () => {
          if (cancelled || !video.videoWidth) {
            if (!cancelled) rafRef.current = requestAnimationFrame(tick);
            return;
          }

          /* Crop to viewfinder ROI for better accuracy */
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
            if (results.length > 0 && !cancelled) {
              handleDetected(results[0].rawValue);
            }
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

        streamRef.current = stream;
        checkTorch(stream);
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        if (cancelled) { stop(); return; }
        setScanning(true);

        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromStream(stream, video, (result, _err, ctrl) => {
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
            <div className="relative overflow-hidden rounded-xl bg-black aspect-video shadow-inner">
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
              <canvas ref={canvasRef} className="hidden" />

              {scanning && (
                <>
                  {/* Dark overlays — fractions must match ROI constants */}
                  <div className="absolute inset-x-0 top-0 bg-black/60 pointer-events-none" style={{ bottom: '50%' }} />
                  <div className="absolute inset-x-0 bottom-0 bg-black/60 pointer-events-none" style={{ top: '75%' }} />
                  <div className="absolute bg-black/60 pointer-events-none" style={{ top: '25%', bottom: '25%', left: 0, right: '90%' }} />
                  <div className="absolute bg-black/60 pointer-events-none" style={{ top: '25%', bottom: '25%', left: '90%', right: 0 }} />

                  {/* Viewfinder box */}
                  <div
                    className="absolute pointer-events-none"
                    style={{ top: '25%', bottom: '25%', left: '10%', right: '10%' }}
                  >
                    {/* Corner brackets */}
                    <span className="absolute top-0 left-0 w-7 h-7 border-t-[3px] border-l-[3px] border-green-400 rounded-tl-sm" />
                    <span className="absolute top-0 right-0 w-7 h-7 border-t-[3px] border-r-[3px] border-green-400 rounded-tr-sm" />
                    <span className="absolute bottom-0 left-0 w-7 h-7 border-b-[3px] border-l-[3px] border-green-400 rounded-bl-sm" />
                    <span className="absolute bottom-0 right-0 w-7 h-7 border-b-[3px] border-r-[3px] border-green-400 rounded-br-sm" />

                    {/* Animated scan line */}
                    <div
                      className="absolute inset-x-2 h-0.5 bg-green-400/90 shadow-[0_0_8px_3px_rgba(74,222,128,0.7)]"
                      style={{ animation: 'scanline 1.6s ease-in-out infinite' }}
                    />
                  </div>

                  {/* Torch button — only shown if device supports it */}
                  {hasTorch && (
                    <button
                      onClick={toggleTorch}
                      className={`absolute top-2 right-2 rounded-full p-2 transition-colors z-10 ${
                        torch
                          ? "bg-yellow-400 text-yellow-900"
                          : "bg-black/50 text-white"
                      }`}
                      title={torch ? "Turn torch off" : "Turn torch on"}
                    >
                      {torch ? <ZapOff className="w-5 h-5" /> : <Zap className="w-5 h-5" />}
                    </button>
                  )}

                  {/* Instruction */}
                  <div className="absolute bottom-2 left-0 right-0 text-center text-xs text-green-300 font-medium pointer-events-none tracking-wide">
                    Align barcode inside the box
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
