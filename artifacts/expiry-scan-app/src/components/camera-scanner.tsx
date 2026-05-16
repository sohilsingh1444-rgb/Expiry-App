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

export function CameraScanner({ open, onClose, onDetected }: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const stoppedRef = useRef(false);

  const handleDetected = useCallback(
    (barcode: string) => {
      onDetected(barcode);
      onClose();
    },
    [onDetected, onClose],
  );

  useEffect(() => {
    if (!open) return;

    setError(null);
    setScanning(false);
    stoppedRef.current = false;

    const reader = new BrowserMultiFormatReader();
    let started = false;

    (async () => {
      try {
        const devices = await BrowserMultiFormatReader.listVideoInputDevices();
        if (devices.length === 0) {
          setError("No camera found on this device.");
          return;
        }

        const backCamera = devices.find(
          (d) =>
            d.label.toLowerCase().includes("back") ||
            d.label.toLowerCase().includes("rear") ||
            d.label.toLowerCase().includes("environment"),
        );
        const deviceId = backCamera?.deviceId ?? devices[devices.length - 1].deviceId;

        if (stoppedRef.current) return;
        started = true;
        setScanning(true);

        await reader.decodeFromVideoDevice(
          deviceId,
          videoRef.current!,
          (result, err) => {
            if (stoppedRef.current) return;
            if (result) {
              stoppedRef.current = true;
              BrowserMultiFormatReader.releaseAllStreams();
              handleDetected(result.getText());
            } else if (err && (err as Error).name !== "NotFoundException") {
              // NotFoundException is normal — no barcode in frame yet
            }
          },
        );
      } catch (e) {
        if (!stoppedRef.current) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.toLowerCase().includes("permission") || msg.toLowerCase().includes("denied")) {
            setError("Camera access was denied. Please allow camera permission and try again.");
          } else {
            setError("Could not start camera: " + msg);
          }
          setScanning(false);
        }
      }
    })();

    return () => {
      stoppedRef.current = true;
      if (started) {
        BrowserMultiFormatReader.releaseAllStreams();
      }
      setScanning(false);
    };
  }, [open, handleDetected]);

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
              {scanning && (
                <>
                  <div className="absolute inset-0 border-[3px] border-amber-400 rounded-xl pointer-events-none" />
                  <div className="absolute left-4 right-4 top-1/2 -translate-y-1/2 h-0.5 bg-amber-400 opacity-80 animate-pulse pointer-events-none" />
                  <div className="absolute bottom-2 left-0 right-0 text-center text-xs text-amber-300 font-medium pointer-events-none">
                    Point at barcode
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

          <Button
            variant="outline"
            className="w-full"
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
