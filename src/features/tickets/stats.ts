/**
 * Stats de staff en tickets: cuántos atendió, cómo los calificó quien abrió cada uno, y la
 * transcripción de cada uno guardada en disco (data/transcripts/<servidor>/<id>.txt) para poder
 * pedirla después por calificación. Todo separado por servidor.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../../paths.js";
import { getValue, setValue } from "../../store.js";

const CONFIG_KEY = "ticketStats";
const TRANSCRIPTS_DIR = path.join(DATA_DIR, "transcripts");

export type Rating = "bien" | "mal" | "indiferente";
export const RATINGS: readonly Rating[] = ["bien", "mal", "indiferente"];
export const isRating = (value: string | undefined): value is Rating => RATINGS.includes(value as Rating);

export interface StaffStats {
  attended: number;
  bien: number;
  mal: number;
  indiferente: number;
}

export interface TicketRecord {
  id: string; // ID del canal que tuvo el ticket
  claimerId: string;
  openerId: string;
  category: string;
  closedAt: number;
  rating: Rating | null;
  /**
   * Ruta del archivo RELATIVA a la carpeta de transcripciones (así se puede mover el bot de
   * carpeta o de máquina). Los registros viejos pueden tener una ruta absoluta.
   */
  transcriptPath: string;
}

interface StatsStore {
  staff: Record<string, StaffStats>;
  records: TicketRecord[];
}

const getStore = (guildId: string): Promise<StatsStore> => getValue<StatsStore>(guildId, CONFIG_KEY, { staff: {}, records: [] });
const setStore = (guildId: string, data: StatsStore): Promise<void> => setValue(guildId, CONFIG_KEY, data);

const emptyStats = (): StaffStats => ({ attended: 0, bien: 0, mal: 0, indiferente: 0 });

/** Guarda la transcripción en disco y devuelve la ruta (relativa) donde quedó. */
export async function saveTranscript(guildId: string, ticketId: string, text: string): Promise<string> {
  const relative = path.join(guildId, `${ticketId}.txt`);
  const filePath = path.join(TRANSCRIPTS_DIR, relative);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
  return relative;
}

/** Lee el archivo de una transcripción, o null si ya no está. */
export async function readTranscript(record: TicketRecord): Promise<Buffer | null> {
  const candidates = path.isAbsolute(record.transcriptPath)
    ? [record.transcriptPath, path.join(TRANSCRIPTS_DIR, path.basename(record.transcriptPath))]
    : [path.join(TRANSCRIPTS_DIR, record.transcriptPath)];
  for (const file of candidates) {
    const content = await readFile(file).catch(() => null);
    if (content) return content;
  }
  return null;
}

/** Se llama al cerrar un ticket que sí fue reclamado: suma 1 a "atendidos" de ese staff. */
export async function recordTicketClosed(guildId: string, record: Omit<TicketRecord, "rating">): Promise<void> {
  const store = await getStore(guildId);
  if (store.records.some((r) => r.id === record.id)) return; // ya registrado (doble clic en "Cerrar")
  store.records.push({ ...record, rating: null });
  const stats = store.staff[record.claimerId] ?? emptyStats();
  stats.attended += 1;
  store.staff[record.claimerId] = stats;
  await setStore(guildId, store);
}

/** Se llama cuando quien abrió el ticket responde la encuesta. Devuelve el registro, o null si no corresponde. */
export async function rateTicket(guildId: string, ticketId: string, openerId: string, rating: Rating): Promise<TicketRecord | null> {
  const store = await getStore(guildId);
  const record = store.records.find((r) => r.id === ticketId);
  if (!record || record.openerId !== openerId || record.rating !== null) return null;

  record.rating = rating;
  const stats = store.staff[record.claimerId] ?? emptyStats();
  stats[rating] += 1;
  store.staff[record.claimerId] = stats;
  await setStore(guildId, store);
  return record;
}

export async function getStaffStats(guildId: string, staffId: string): Promise<StaffStats> {
  const store = await getStore(guildId);
  return store.staff[staffId] ?? emptyStats();
}

export async function getRecords(guildId: string, staffId: string, rating?: Rating): Promise<TicketRecord[]> {
  const store = await getStore(guildId);
  return store.records.filter((r) => r.claimerId === staffId && (!rating || r.rating === rating));
}

export async function getRecordById(guildId: string, ticketId: string): Promise<TicketRecord | undefined> {
  const store = await getStore(guildId);
  return store.records.find((r) => r.id === ticketId);
}
