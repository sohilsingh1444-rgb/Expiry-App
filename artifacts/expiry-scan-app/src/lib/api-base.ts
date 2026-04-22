const PRODUCTION_API = "https://expiry-scan-api.onrender.com";

export function getApiBase(): string {
  const viteApiUrl = import.meta.env.VITE_API_URL as string | undefined;
  if (viteApiUrl) return viteApiUrl.replace(/\/$/, "");
  if (import.meta.env.PROD) return PRODUCTION_API;
  return (import.meta.env.BASE_URL as string ?? "/").replace(/\/$/, "");
}
