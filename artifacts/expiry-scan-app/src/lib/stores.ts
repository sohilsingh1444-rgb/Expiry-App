export const STORES = [
  { name: "Newworld Ba1",         code: "S0001", region: "WR" },
  { name: "Newworld Ba3",         code: "S0003", region: "WR" },
  { name: "Newworld Adams",       code: "S0005", region: "WR" },
  { name: "Newworld Namaka",      code: "S0006", region: "WR" },
  { name: "Newworld Nadi Town",   code: "S0010", region: "WR" },
  { name: "IGA Super",            code: "S0011", region: "WR" },
  { name: "Newworld Rakiraki",    code: "S0013", region: "WR" },
  { name: "Newworld Tavua",       code: "S0025", region: "WR" },
  { name: "IGA Lautoka",          code: "S0018", region: "WR" },
  { name: "IGA Waiyavi",          code: "S0035", region: "WR" },
  { name: "IGA Nadi Plaza",       code: "S0036", region: "WR" },
  { name: "Lautoka Warehouse",    code: "B0004", region: "WR" },
  { name: "Nwl CDC",              code: "B0008", region: "WR" },
  { name: "Ghimly Warehouse",     code: "B0002", region: "WR" },
  { name: "Ba Warehouse",         code: "B0001", region: "WR" },
  { name: "IGA Nakasi",           code: "S0019", region: "CR" },
  { name: "Newworld Narere",      code: "S0020", region: "CR" },
  { name: "Newworld VitiPlaza",   code: "S0026", region: "CR" },
  { name: "Newworld Nausori",     code: "S0021", region: "CR" },
  { name: "IGA Damodhar",         code: "S0029", region: "CR" },
  { name: "IGA Greig St",         code: "S0033", region: "CR" },
  { name: "Central Bakery",       code: "S0032", region: "CR" },
  { name: "Vatuwaqa Warehouse",   code: "B0003", region: "CR" },
  { name: "Newworld Labasa",      code: "S0014", region: "NR" },
  { name: "IGA Savusavu",         code: "S0016", region: "NR" },
] as const;

export type Region = "WR" | "CR" | "NR";
export type StoreEntry = (typeof STORES)[number];

export function getStoreByCode(code: string): StoreEntry | undefined {
  return STORES.find(s => s.code.toLowerCase() === code.toLowerCase()) as StoreEntry | undefined;
}

export function getStoreRegion(code: string): Region | undefined {
  return getStoreByCode(code)?.region as Region | undefined;
}
