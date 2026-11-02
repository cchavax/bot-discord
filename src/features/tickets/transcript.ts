/** Armado del texto de la transcripción de un ticket (lógica pura, testeable). */

export interface TranscriptEntry {
  time: Date;
  author: string;
  content: string;
  attachments: string[];
}

export interface TranscriptHeader {
  channel: string;
  category: string;
  opener: string;
  claimedBy?: string;
  closedBy: string;
  closedAt: Date;
}

const fmt = (d: Date): string => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function buildTranscript(header: TranscriptHeader, entries: TranscriptEntry[]): string {
  const lines: string[] = [
    `Transcripción de ${header.channel}`,
    `Categoría: ${header.category}`,
    `Abierto por: ${header.opener}`,
    `Atendido por: ${header.claimedBy ?? "(nadie lo reclamó)"}`,
    `Cerrado por: ${header.closedBy} el ${fmt(header.closedAt)}`,
    `Mensajes: ${entries.length}`,
    "-".repeat(48),
  ];

  const sorted = [...entries].sort((a, b) => a.time.getTime() - b.time.getTime());
  for (const e of sorted) {
    const [first = "", ...rest] = e.content.split("\n");
    lines.push(`[${fmt(e.time)}] ${e.author}: ${first}`);
    for (const line of rest) lines.push(`    ${line}`);
    for (const url of e.attachments) lines.push(`    📎 ${url}`);
  }
  return lines.join("\n");
}
