export function getApiBase(): string {
  const viteApiUrl = import.meta.env.VITE_API_URL as string | undefined;
  if (viteApiUrl) return viteApiUrl.replace(/\/$/, "");
  return "";
}
