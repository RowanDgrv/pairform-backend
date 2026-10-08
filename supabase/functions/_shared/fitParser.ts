// =============================================================================
//  Parseur binaire .FIT — zéro dépendance, port Deno de sillance-fit.js
//  (readFitArrayBuffer), testé à l'origine sur des exports COROS PACE 2 via
//  l'app iDO. Robustesse volontaire : on avance TOUJOURS de la taille
//  déclarée par chaque définition de champ, sans jamais valider taille/type —
//  un vrai export COROS contient des champs développeur non standards qui
//  font planter des libs strictes ; ignorer ce qu'on ne reconnaît pas au lieu
//  de le valider est ce qui rend ce parseur tolérant.
//
//  Renvoie { points, laps } dans la MÊME forme que normalizeStravaStreams /
//  normalizeStravaLaps (providers.ts) : le front rejoue ensuite tout avec
//  PFFit.buildFromRaw, sans distinguer la provenance (Strava/upload/COROS).
// =============================================================================

export interface FitPoint {
  time: number | null; lat: number | null; lon: number | null; alt: number | null;
  distM: number | null; hr: number; cad: number; pw: number; spdMs: number | null;
  stepLen: number | null;
}
export interface FitLap {
  start: number; end: number; durS?: number; distM?: number;
  avgHr?: number; maxHr?: number; avgSpeedMs?: number; avgWatts?: number;
  avgCad?: number; elevGain?: number;
}

const FIT_EPOCH_OFFSET = 631065600; // secondes entre 1970-01-01 et 1989-12-31 (epoch FIT)

const FIT_BASE_SIZE: Record<number, number> = {
  0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 0x83: 2, 0x84: 2, 0x85: 4,
  0x86: 4, 0x87: 8, 0x88: 4, 0x89: 8, 0x0A: 1, 0x8B: 2, 0x8C: 4, 0x0D: 1,
  0x8E: 8, 0x8F: 8, 0x90: 8,
};
// Champs du message "record" (global msg 20). 85=step_length, présent
// seulement sur montres avec capteur RD (Coros/Garmin) — jamais inventé si absent.
const REC_FIELDS: Record<number, string> = {
  253: "timestamp", 0: "lat", 1: "lon", 2: "alt", 78: "ealt", 3: "hr", 4: "cad",
  5: "dist", 6: "spd", 73: "espd", 7: "pw", 85: "steplen",
};
// Message "lap" (global msg 19) : timestamp (253) marque la FIN du lap.
const LAP_FIELDS: Record<number, string> = {
  253: "timestamp", 7: "elapsedTime", 8: "timerTime", 9: "totalDist",
  13: "avgSpeed", 15: "avgHr", 16: "maxHr", 17: "avgCad", 19: "avgPower", 21: "ascent",
};

/** Décode un buffer .FIT brut → points « raw » + laps « lapsRaw », au même
 *  format que ce que renvoie l'API Strava une fois normalisé côté serveur. */
export function parseFitArrayBuffer(buf: ArrayBuffer): { points: FitPoint[]; laps: FitLap[] } {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (bytes.length < 14 || String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) !== ".FIT") {
    throw new Error("signature .FIT invalide");
  }
  const headerSize = bytes[0];
  const dataSize = view.getUint32(4, true);
  const end = Math.min(bytes.length, headerSize + dataSize);
  let offset = headerSize;
  const localDefs: Record<number, { globalMsgNum: number; fields: Array<{ num: number; size: number; type: number }>; devFields: Array<{ size: number }>; le: boolean }> = {};
  const raw: FitPoint[] = [];
  const lapEnds: number[] = []; // timestamps FIT (secondes) de fin de chaque lap réel
  const lapStats: Array<Record<string, number | undefined>> = []; // stats officielles de la montre, parallèle à lapEnds
  let lastTimestamp: number | null = null;

  function readField(sz: number, baseType: number, littleEndian: boolean): number | null {
    let v: number | null;
    if (sz === FIT_BASE_SIZE[baseType]) {
      switch (baseType) {
        case 0x83: v = view.getInt16(offset, littleEndian); break;
        case 0x84: v = view.getUint16(offset, littleEndian); break;
        case 0x85: v = view.getInt32(offset, littleEndian); break;
        case 0x86: v = view.getUint32(offset, littleEndian); break;
        case 0x88: v = view.getFloat32(offset, littleEndian); break;
        case 0x89: v = view.getFloat64(offset, littleEndian); break;
        case 1: v = view.getInt8(offset); break;
        default: v = view.getUint8(offset);
      }
    } else {
      v = null; // taille inattendue pour ce type : on ne décode pas, mais on avance quand même
    }
    offset += sz;
    return v;
  }

  while (offset < end) {
    const header = bytes[offset]; offset += 1;
    let localType: number, def, isDefinition = false, tsOffset: number | null = null;
    if (header & 0x80) { // compressed timestamp header
      localType = (header >> 5) & 0x3;
      tsOffset = header & 0x1F;
    } else {
      isDefinition = !!(header & 0x40);
      localType = header & 0xF;
    }

    if (isDefinition) {
      // Un champ développeur mal déclaré plus loin dans le flux désynchronise
      // la lecture ; le détecter ICI et arrêter proprement (garder les points
      // déjà lus) vaut mieux que continuer à lire des octets désynchronisés.
      if (offset + 5 > end) break;
      offset += 1; // reserved
      const arch = bytes[offset]; offset += 1;
      const le = arch === 0;
      const globalMsgNum = view.getUint16(offset, le); offset += 2;
      const numFields = bytes[offset]; offset += 1;
      if (numFields > 40 || offset + numFields * 3 > end) break;
      const fields: Array<{ num: number; size: number; type: number }> = [];
      let fieldsOk = true;
      for (let i = 0; i < numFields; i++) {
        const size = bytes[offset + 1];
        if (size === 0 || size > 32) { fieldsOk = false; break; }
        fields.push({ num: bytes[offset], size, type: bytes[offset + 2] });
        offset += 3;
      }
      if (!fieldsOk) break;
      const devFields: Array<{ size: number }> = [];
      if (header & 0x20) { // has developer data
        if (offset + 1 > end) break;
        const numDev = bytes[offset]; offset += 1;
        if (numDev > 40 || offset + numDev * 3 > end) break;
        for (let i = 0; i < numDev; i++) {
          const size = bytes[offset + 1];
          if (size === 0 || size > 32) break;
          devFields.push({ size }); offset += 3;
        }
      }
      localDefs[localType] = { globalMsgNum, fields, devFields, le };
      continue;
    }

    def = localDefs[localType];
    if (!def) break; // message inconnu sans définition préalable : on ne peut pas avancer en sécurité

    if (tsOffset != null && lastTimestamp != null) {
      let ts = (lastTimestamp & ~0x1F) | tsOffset;
      if (ts < lastTimestamp) ts += 0x20;
      lastTimestamp = ts;
    }

    const rec: Record<string, number | null> = {};
    for (const f of def.fields) {
      const name = def.globalMsgNum === 20 ? REC_FIELDS[f.num] : def.globalMsgNum === 19 ? LAP_FIELDS[f.num] : null;
      if (name) rec[name] = readField(f.size, f.type, def.le);
      else offset += f.size; // champ non reconnu : on saute sans décoder
    }
    for (const df of def.devFields) offset += df.size; // champs développeur : toujours ignorés

    // Valeurs "invalid" FIT (sentinelles par taille de champ) : à traiter
    // comme absentes AVANT tout calcul d'échelle.
    const INVALID16 = 0xFFFF, INVALID32 = 0xFFFFFFFF, INVALID_LAT = 0x7FFFFFFF;
    if (rec.ealt === INVALID32) rec.ealt = null;
    if (rec.alt === INVALID16) rec.alt = null;
    if (rec.espd === INVALID32) rec.espd = null;
    if (rec.spd === INVALID16) rec.spd = null;
    if (rec.dist === INVALID32) rec.dist = null;
    if (rec.lat === INVALID_LAT || rec.lat === -INVALID_LAT - 1) rec.lat = null;
    if (rec.lon === INVALID_LAT || rec.lon === -INVALID_LAT - 1) rec.lon = null;
    if (rec.steplen === INVALID16) rec.steplen = null;

    if (def.globalMsgNum === 20) {
      if (rec.timestamp != null) lastTimestamp = rec.timestamp;
      const ts = rec.timestamp != null ? rec.timestamp : lastTimestamp;
      if (ts == null) continue;
      const alt = rec.ealt != null ? rec.ealt / 5 - 500 : (rec.alt != null ? rec.alt / 5 - 500 : null);
      const spd = rec.espd != null ? rec.espd / 1000 : (rec.spd != null ? rec.spd / 1000 : null);
      raw.push({
        time: (ts + FIT_EPOCH_OFFSET) * 1000,
        lat: rec.lat != null ? rec.lat * (180 / 2147483648) : null,
        lon: rec.lon != null ? rec.lon * (180 / 2147483648) : null,
        alt: (alt != null && alt > -500) ? alt : null,
        distM: rec.dist != null ? rec.dist / 100 : null,
        hr: (rec.hr != null && rec.hr < 255) ? rec.hr : 0,
        cad: (rec.cad != null && rec.cad < 255) ? rec.cad : 0,
        pw: (rec.pw != null && rec.pw < 65535) ? rec.pw : 0,
        spdMs: (spd != null && spd < 100) ? spd : null,
        stepLen: rec.steplen != null ? rec.steplen / 10000 : null,
      });
    }
    if (def.globalMsgNum === 19) {
      const ts = rec.timestamp != null ? rec.timestamp : lastTimestamp;
      if (ts != null) {
        lapEnds.push(ts); lastTimestamp = ts;
        lapStats.push({
          durS: rec.timerTime != null ? rec.timerTime / 1000 : (rec.elapsedTime != null ? rec.elapsedTime / 1000 : undefined),
          distM: rec.totalDist != null ? rec.totalDist / 100 : undefined,
          avgHr: (rec.avgHr != null && rec.avgHr < 255) ? rec.avgHr : undefined,
          maxHr: (rec.maxHr != null && rec.maxHr < 255) ? rec.maxHr : undefined,
          avgSpeedMs: rec.avgSpeed != null ? rec.avgSpeed / 1000 : undefined,
          avgWatts: (rec.avgPower != null && rec.avgPower < 65535) ? rec.avgPower : undefined,
          avgCad: (rec.avgCad != null && rec.avgCad < 255) ? rec.avgCad : undefined,
          elevGain: rec.ascent != null ? rec.ascent : undefined,
        });
      }
    }
  }
  if (!raw.length) throw new Error("aucun point d'activité (message 'record') trouvé dans le fichier");

  // Convertit les timestamps de fin de lap (FIT) en bornes d'index sur `raw`.
  const laps: FitLap[] = [];
  if (lapEnds.length) {
    const sortedLaps = lapEnds.map((ts, i) => ({ ts, stats: lapStats[i] })).sort((a, b) => a.ts - b.ts);
    let start = 0;
    for (const { ts: endFitSec, stats } of sortedLaps) {
      const endMs = (endFitSec + FIT_EPOCH_OFFSET) * 1000;
      let idx = raw.length;
      for (let i = start; i < raw.length; i++) { if ((raw[i].time ?? 0) >= endMs) { idx = i; break; } }
      const boundEnd = Math.max(idx, start + 1);
      if (boundEnd > start) laps.push({ start, end: Math.min(boundEnd, raw.length), ...stats });
      start = Math.min(boundEnd, raw.length);
    }
    if (start < raw.length) laps.push({ start, end: raw.length });
  }

  return { points: raw, laps };
}
