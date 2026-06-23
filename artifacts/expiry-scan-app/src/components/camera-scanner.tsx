import { useEffect, useRef, useState, useCallback } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Camera } from "lucide-react";

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
  // Fallback list if getSupportedFormats() is not available
  return [
    "ean_13", "ean_8", "upc_a", "upc_e",
    "code_128", "code_39", "code_93", "itf",
    "codabar", "code_39_mod_43", "aztec",
    "pdf417", "qr_code", "data_matrix",
    "unknown",
  ];
}

export function CameraScanner({ open, onClose, onDetected }: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const zxingControlsRef = useRef<{ stop(): void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (zxingControlsRef.current) {
      try { zxingControlsRef.current.stop(); } catch { /* ignore */ }
      zxingControlsRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const handleDetected = useCallback(
    (barcode: string) => {
      stop();
      onDetected(barcode);
      onClose();
    },
    [stop, onDetected, onClose],
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    setScanning(false);

    let cancelled = false;

    async function startNative() {
      try {
        const formats = await getSupportedFormats();
        // @ts-ignore — BarcodeDetector is not in TS lib yet
        const detector = new BarcodeDetector({ formats });
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }

        streamRef.current = stream;
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        if (cancelled) { stop(); return; }
        setScanning(true);

        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

        const tick = async () => {
          if (cancelled || !video.videoWidth) {
            if (!cancelled) rafRef.current = requestAnimationFrame(() => { tick(); });
            return;
          }
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          try {
            // @ts-ignore
            const results = await detector.detect(canvas);
            if (results.length > 0 && !cancelled) {
              cancelled = true;
              handleDetected(results[0].rawValue as string);
              return;
            }
          } catch { /* no barcode in frame — normal */ }
          if (!cancelled) rafRef.current = requestAnimationFrame(() => { tick(); });
        };
        rafRef.current = requestAnimationFrame(() => { tick(); });
      } catch (e) {
        if (!cancelled) startZxing(e);
      }
    }

    async function startZxing(previousError?: unknown) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }

        streamRef.current = stream;
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        if (cancelled) { stop(); return; }
        setScanning(true);

        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromStream(stream, video, (result, err, controls) => {
          if (cancelled) { controls?.stop(); return; }
          if (result) {
            cancelled = true;
            controls?.stop();
            handleDetected(result.getText());
          } else if (err && (err as Error).name !== "NotFoundException") {
            // ignore expected "no barcode" frames
          }
        });
        zxingControlsRef.current = controls;
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
              <video
                ref={videoRef}
                className="w-full h-full object-cover"
                muted
                playsInline
              />
              <canvas ref={canvasRef} className="hidden" />

              {scanning && (
                <>
                  {/* Dark overlay: top */}
                  <div className="absolute inset-x-0 top-0 bg-black/55 pointer-events-none" style={{ bottom: '25%' }} />
                  {/* Dark overlay: bottom */}
                  <div className="absolute inset-x-0 bottom-0 bg-black/55 pointer-events-none" style={{ top: '75%' }} />
                  {/* Dark overlay: left strip (middle band) */}
                  <div className="absolute bg-black/55 pointer-events-none" style={{ top: '25%', bottom: '25%', left: 0, right: '80%' }} />
                  {/* Dark overlay: right strip (middle band) */}
                  <div className="absolute bg-black/55 pointer-events-none" style={{ top: '25%', bottom: '25%', left: '80%', right: 0 }} />

                  {/* Viewfinder box border */}
                  <div
                    className="absolute pointer-events-none"
                    style={{ top: '25%', bottom: '25%', left: '10%', right: '10%' }}
                  >
                    {/* Corner brackets */}
                    {/* Top-left */}
                    <span className="absolute top-0 left-0 w-6 h-6 border-t-[3px] border-l-[3px] border-amber-400 rounded-tl-sm" />
                    {/* Top-right */}
                    <span className="absolute top-0 right-0 w-6 h-6 border-t-[3px] border-r-[3px] border-amber-400 rounded-tr-sm" />
                    {/* Bottom-left */}
                    <span className="absolute bottom-0 left-0 w-6 h-6 border-b-[3px] border-l-[3px] border-amber-400 rounded-bl-sm" />
                    {/* Bottom-right */}
                    <span className="absolute bottom-0 right-0 w-6 h-6 border-b-[3px] border-r-[3px] border-amber-400 rounded-br-sm" />

                    {/* Animated scan line inside the box */}
                    <div className="absolute inset-x-2 h-0.5 bg-amber-400/90 shadow-[0_0_6px_2px_rgba(251,191,36,0.6)]"
                      style={{ animation: 'scanline 1.8s ease-in-out infinite' }}
                    />
                  </div>

                  {/* Instruction label */}
                  <div className="absolute bottom-2 left-0 right-0 text-center text-xs text-amber-300 font-medium pointer-events-none tracking-wide">
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
