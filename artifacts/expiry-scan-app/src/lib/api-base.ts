export function getApiBase(): string {
  const externalApi = import.meta.env.VITE_API_URL as string | undefined;
  if (externalApi) return externalApi.replace(/\/$/, "");
  return (import.meta.env.BASE_URL as string ?? "/").replace(/\/$/, "");
}
