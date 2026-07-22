/* ============================================================
   Sillance — Import d'activités .TCX / .GPX / .FIT  (window.PFFit)
   ------------------------------------------------------------
   Convertit un fichier exporté d'une montre (Garmin, Coros, Polar…)
   en la MÊME structure que genSessionData() de l'app, afin que tout
   le modal d'analyse (vitesse, FC, altitude, puissance, DÉCOUPLAGE,
   ASSISTANT IA) fonctionne sur des données RÉELLES.

   .TCX/.GPX : XML, zéro dépendance, parse via DOMParser.
   .FIT : binaire, parseur maison zéro dépendance (parseFitArrayBuffer).
   Robustesse volontaire : on avance TOUJOURS de la taille déclarée par
   chaque définition de champ, sans jamais valider taille/type — un vrai
   export (testé sur COROS PACE 2 via l'app iDO) contient des champs
   développeur non standards qui font planter des libs strictes (dont
   la référence Python `fitparse`) ; ignorer ce qu'on ne reconnaît pas
   au lieu de le valider est ce qui rend ce parseur plus tolérant.

   API :
     PFFit.parse(text, filename, opts)  -> { ok, error?, summary, data }
     PFFit.parseFile(File, opts)        -> Promise<même chose>
   `data` = { pts, laps, dplus, dist, avgHr, maxHr, avgSpeed, avgGap, disc, cond }
   ============================================================ */
(function (root) {
  "use strict";

  const NEUTRAL_COND = { temp: 15, humidity: 50, wind: 0, windHead: false };
  const FIT_EPOCH_OFFSET = 631065600; // secondes entre 1970-01-01 et 1989-12-31 (epoch FIT)

  function parseFile(file, opts) {
    const name = (file.name || "").toLowerCase();
    if (/\.fit$/.test(name)) {
      return new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => {
          try {
            const { raw, disc } = readFitArrayBuffer(r.result);
            resolve(finishParse(raw, disc, [], opts, "FIT"));
          } catch (e) {
            resolve({ ok: false, error: "Fichier .FIT illisible : " + (e && e.message ? e.message : e) });
          }
        };
        r.onerror = () => resolve({ ok: false, error: "Lecture du fichier impossible." });
        r.readAsArrayBuffer(file);
      });
    }
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(parse(String(r.result || ""), file.name || "", opts));
      r.onerror = () => resolve({ ok: false, error: "Lecture du fichier impossible." });
      r.readAsText(file);
    });
  }

  function finishParse(raw, disc, lapsRaw, opts, source) {
    if (disc == null) disc = "run";
    if (!raw || raw.length < 4) return { ok: false, error: "Pas assez de points GPS/capteur dans le fichier." };
    const data = buildData(raw, disc, lapsRaw, opts);
    const summary = {
      provider: "upload",
      source,
      disc,
      title: titleFor(disc, data),
      date: raw[0].time ? new Date(raw[0].time) : null,
      durMin: Math.round(data.pts[data.pts.length - 1].t),
      dist: +data.dist.toFixed(2),
      avgHr: data.avgHr, maxHr: data.maxHr,
      avgSpeed: +data.avgSpeed.toFixed(2),
      dplus: data.dplus,
      hasPower: data.pts.some((p) => p.pw > 0),
      hasHr: data.pts.some((p) => p.hr > 0),
    };
    return { ok: true, summary, data };
  }

  /* ---------- FIT (binaire) ---------- */
  // Taille en octets par base type FIT (table officielle, pour LIRE les champs
  // qu'on reconnaît — on ne s'en sert JAMAIS pour valider la taille déclarée,
  // toujours celle-ci qui fait foi pour avancer dans le buffer).
  const FIT_BASE_SIZE = { 0:1,1:1,2:1,3:1,4:1,5:1,6:1,7:1,0x83:2,0x84:2,0x85:4,0x86:4,0x87:8,0x88:4,0x89:8,0x0A:1,0x8B:2,0x8C:4,0x0D:1,0x8E:8,0x8F:8,0x90:8 };
  // Champs du message "record" (global msg 20) qu'on extrait.
  // 85=step_length (dynamiques de course, présent seulement sur les montres
  // avec capteur RD type Coros/Garmin — jamais inventé si absent du fichier).
  const REC_FIELDS = { 253:'timestamp', 0:'lat', 1:'lon', 2:'alt', 78:'ealt', 3:'hr', 4:'cad', 5:'dist', 6:'spd', 73:'espd', 7:'pw', 85:'steplen' };

  function readFitArrayBuffer(buf) {
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    if (bytes.length < 14 || String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) !== ".FIT") {
      throw new Error("signature .FIT absente (fichier corrompu ou mauvais format)");
    }
    const headerSize = bytes[0];
    const dataSize = view.getUint32(4, true);
    const end = Math.min(bytes.length, headerSize + dataSize);
    let offset = headerSize;
    const localDefs = {};
    const raw = [];
    let lastTimestamp = null; // secondes FIT, pour les en-têtes "compressed timestamp"
    let sportMsg = null;

    function readField(sz, baseType, littleEndian) {
      let v;
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
      let localType, def, isDefinition = false, tsOffset = null;
      if (header & 0x80) { // compressed timestamp header
        localType = (header >> 5) & 0x3;
        tsOffset = header & 0x1F;
      } else {
        isDefinition = !!(header & 0x40);
        localType = header & 0xF;
      }

      if (isDefinition) {
        // Une définition plausible a peu de champs, de taille raisonnable.
        // Un fichier réel (COROS via iDO observé) contient un champ développeur
        // mal déclaré plus loin dans le flux ; le détecter ICI et arrêter
        // proprement (on garde les points déjà lus) vaut mieux que continuer
        // à lire des octets désormais désynchronisés comme si de rien n'était.
        if (offset + 5 > end) break;
        offset += 1; // reserved
        const arch = bytes[offset]; offset += 1;
        const le = arch === 0;
        const globalMsgNum = view.getUint16(offset, le); offset += 2;
        const numFields = bytes[offset]; offset += 1;
        if (numFields > 40 || offset + numFields * 3 > end) break;
        const fields = [];
        let fieldsOk = true;
        for (let i = 0; i < numFields; i++) {
          const size = bytes[offset + 1];
          if (size === 0 || size > 32) { fieldsOk = false; break; }
          fields.push({ num: bytes[offset], size, type: bytes[offset + 2] });
          offset += 3;
        }
        if (!fieldsOk) break;
        let devFields = [];
        if (header & 0x20) { // has developer data
          if (offset + 1 > end) break;
          const numDev = bytes[offset]; offset += 1;
          if (numDev > 40 || offset + numDev * 3 > end) break;
          for (let i = 0; i < numDev; i++) {
            const size = bytes[offset + 1];
            if (size === 0 || size > 32) { i = numDev; break; }
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

      const rec = {};
      for (const f of def.fields) {
        const name = def.globalMsgNum === 20 ? REC_FIELDS[f.num] : null;
        if (name) rec[name] = readField(f.size, f.type, def.le);
        else offset += f.size; // champ non reconnu : on saute sans décoder
      }
      for (const df of def.devFields) offset += df.size; // champs développeur : toujours ignorés

      // Valeurs "invalid" FIT (sentinelles par taille de champ) : à traiter
      // comme absentes AVANT tout calcul d'échelle, sinon 0xFFFF (capteur
      // muet un instant) devient une altitude de 12 607 m ou 235 km/h.
      const INVALID16 = 0xFFFF, INVALID32 = 0xFFFFFFFF, INVALID_LAT = 0x7FFFFFFF;
      if (rec.ealt === INVALID32) rec.ealt = null;
      if (rec.alt === INVALID16) rec.alt = null;
      if (rec.espd === INVALID32) rec.espd = null;
      if (rec.spd === INVALID16) rec.spd = null;
      if (rec.dist === INVALID32) rec.dist = null;
      if (rec.lat === INVALID_LAT || rec.lat === -INVALID_LAT - 1) rec.lat = null;
      if (rec.lon === INVALID_LAT || rec.lon === -INVALID_LAT - 1) rec.lon = null;
      if (rec.steplen === INVALID16) rec.steplen = null;

      if (def.globalMsgNum === 0 && rec.timestamp == null) { /* file_id, rien à faire */ }
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
          // Longueur de foulée (m) — champ FIT 85 (uint16, échelle 10 → mm),
          // uniquement présent si la montre a un capteur de dynamiques de
          // course (ex. Coros/Garmin RD). Jamais recalculée ni estimée.
          stepLen: rec.steplen != null ? rec.steplen / 10000 : null,
        });
      }
    }
    if (!raw.length) throw new Error("aucun point d'activité (message 'record') trouvé dans le fichier");
    return { raw, disc: sportMsg || "run" };
  }

  function parse(text, filename, opts) {
    opts = opts || {};
    try {
      const name = (filename || "").toLowerCase();
      const doc = new DOMParser().parseFromString(text, "application/xml");
      if (doc.getElementsByTagName("parsererror").length) {
        return { ok: false, error: "Fichier illisible (XML invalide)." };
      }
      const isTcx = !!doc.getElementsByTagName("TrainingCenterDatabase").length || /\.tcx$/.test(name);
      const isGpx = !!doc.getElementsByTagName("gpx").length || /\.gpx$/.test(name);
      let raw, disc, lapsRaw = [];
      if (isTcx) { ({ raw, disc, lapsRaw } = readTcx(doc)); }
      else if (isGpx) { ({ raw, disc } = readGpx(doc)); }
      else return { ok: false, error: "Format non reconnu (attendu .tcx ou .gpx)." };

      if (disc == null) disc = guessDiscFromName(name);
      if (!raw || raw.length < 4) return { ok: false, error: "Pas assez de points GPS/capteur dans le fichier." };

      const data = buildData(raw, disc, lapsRaw, opts);
      const summary = {
        provider: "upload",
        source: isTcx ? "TCX" : "GPX",
        disc,
        title: titleFor(disc, data),
        date: raw[0].time ? new Date(raw[0].time) : null,
        durMin: Math.round(data.pts[data.pts.length - 1].t),
        dist: +data.dist.toFixed(2),
        avgHr: data.avgHr, maxHr: data.maxHr,
        avgSpeed: +data.avgSpeed.toFixed(2),
        dplus: data.dplus,
        hasPower: data.pts.some((p) => p.pw > 0),
        hasHr: data.pts.some((p) => p.hr > 0),
      };
      return { ok: true, summary, data };
    } catch (e) {
      return { ok: false, error: "Erreur de lecture : " + (e && e.message ? e.message : e) };
    }
  }

  /* ---------- TCX ---------- */
  function readTcx(doc) {
    const act = doc.getElementsByTagName("Activity")[0];
    const sport = act ? (act.getAttribute("Sport") || "") : "";
    const disc = sport ? mapSport(sport) : null;
    const raw = [];
    const lapsRaw = [];
    const laps = doc.getElementsByTagName("Lap");
    const tps = doc.getElementsByTagName("Trackpoint");
    // bornes de lap (par index de trackpoint) pour reconstruire les laps réels
    let idx = 0;
    if (laps.length) {
      for (let li = 0; li < laps.length; li++) {
        const start = idx;
        const lapTps = laps[li].getElementsByTagName("Trackpoint");
        for (let i = 0; i < lapTps.length; i++) { pushTcxPoint(lapTps[i], raw); idx++; }
        lapsRaw.push({ start, end: idx }); // [start, end)
      }
    } else {
      for (let i = 0; i < tps.length; i++) pushTcxPoint(tps[i], raw);
    }
    return { raw, disc, lapsRaw };
  }
  function pushTcxPoint(tp, raw) {
    const time = txt(tp, "Time");
    const lat = num(txt1(tp, "LatitudeDegrees"));
    const lon = num(txt1(tp, "LongitudeDegrees"));
    const alt = num(txt(tp, "AltitudeMeters"));
    const distM = num(txt(tp, "DistanceMeters"));
    const hr = num(deepHr(tp));
    const cad = num(txt(tp, "Cadence"));
    // Extensions : Speed (m/s) et Watts
    let spd = null, pw = null;
    const ext = tp.getElementsByTagName("*");
    for (let i = 0; i < ext.length; i++) {
      const ln = local(ext[i].nodeName);
      if (ln === "Speed" && spd == null) spd = num(ext[i].textContent);
      if (ln === "Watts" && pw == null) pw = num(ext[i].textContent);
    }
    raw.push({
      time: time ? Date.parse(time) : null,
      lat, lon,
      alt: isFinite(alt) ? alt : null,
      distM: isFinite(distM) ? distM : null,
      hr: isFinite(hr) ? hr : 0,
      cad: isFinite(cad) ? cad : 0,
      pw: isFinite(pw) ? pw : 0,
      spdMs: isFinite(spd) ? spd : null,
    });
  }
  // FC en TCX = <HeartRateBpm><Value>x</Value></HeartRateBpm>
  function deepHr(tp) {
    const h = tp.getElementsByTagName("HeartRateBpm")[0];
    if (!h) return null;
    const v = h.getElementsByTagName("Value")[0];
    return v ? v.textContent : h.textContent;
  }

  /* ---------- GPX ---------- */
  function readGpx(doc) {
    const raw = [];
    const trkpts = doc.getElementsByTagName("trkpt");
    for (let i = 0; i < trkpts.length; i++) {
      const tp = trkpts[i];
      const lat = num(tp.getAttribute("lat"));
      const lon = num(tp.getAttribute("lon"));
      const alt = num(txt(tp, "ele"));
      const time = txt(tp, "time");
      let hr = 0, cad = 0, pw = 0;
      const ext = tp.getElementsByTagName("*");
      for (let j = 0; j < ext.length; j++) {
        const ln = local(ext[j].nodeName).toLowerCase();
        if (ln === "hr") hr = num(ext[j].textContent) || 0;
        else if (ln === "cad") cad = num(ext[j].textContent) || 0;
        else if (ln === "power" || ln === "watts") pw = num(ext[j].textContent) || 0;
      }
      raw.push({
        time: time ? Date.parse(time) : null,
        lat, lon,
        alt: isFinite(alt) ? alt : null,
        distM: null,
        hr: isFinite(hr) ? hr : 0,
        cad, pw, spdMs: null,
      });
    }
    // discipline GPX : balise <type> dans <trk> (souvent absente)
    let disc = null;
    const t = doc.getElementsByTagName("type")[0];
    if (t) disc = mapSport(t.textContent || "");
    return { raw, disc };
  }

  /* ---------- Construction de `data` (shape genSessionData) ---------- */
  function buildData(raw, disc, lapsRaw, opts) {
    const ftp = opts.ftp || 270;
    const t0 = firstTime(raw);
    let cumKm = 0, prev = null, dplus = 0;
    const pts = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      const tMin = (r.time != null && t0 != null) ? (r.time - t0) / 60000 : (i / Math.max(1, raw.length - 1)) * 60;
      // distance incrémentale
      let dKm = 0, dtH = 0;
      if (prev) {
        if (r.distM != null && prev.distM != null) dKm = Math.max(0, (r.distM - prev.distM) / 1000);
        else if (r.lat != null && r.lon != null && prev.lat != null && prev.lon != null) dKm = haversineKm(prev.lat, prev.lon, r.lat, r.lon);
        dtH = (r.time != null && prev.time != null) ? Math.max(0, (r.time - prev.time) / 3600000) : 0;
      }
      cumKm += dKm;
      // vitesse km/h : capteur si dispo, sinon distance/temps
      let sp = r.spdMs != null ? r.spdMs * 3.6 : (dtH > 0 ? dKm / dtH : (prev ? prev._sp : 0));
      if (!isFinite(sp) || sp < 0) sp = 0;
      if (sp > 120) sp = prev ? prev._sp : 0; // garde-fou GPS aberrant
      // pente % et dénivelé +
      let grade = 0;
      if (prev && prev.alt != null && r.alt != null) {
        const dM = dKm * 1000;
        if (dM > 0.5) grade = clamp(((r.alt - prev.alt) / dM) * 100, -30, 30);
        if (r.alt > prev.alt) dplus += (r.alt - prev.alt);
      }
      const gap = sp * (1 + 0.025 * grade + 0.0018 * grade * grade); // allure corrigée pente
      const pt = {
        t: tMin, sp, hr: r.hr || 0, alt: r.alt != null ? r.alt : (prev ? prev.alt : 0),
        grade, gap, pw: r.pw || 0, cad: r.cad || 0, _sp: sp, _cum: cumKm,
        stepLen: r.stepLen != null ? r.stepLen : 0,
      };
      pts.push(pt);
      prev = { ...r, _sp: sp, distM: r.distM, alt: r.alt != null ? r.alt : (prev ? prev.alt : null) };
    }
    // moyennes globales
    const hrPts = pts.filter((p) => p.hr > 0);
    const avgHr = hrPts.length ? Math.round(avg(hrPts.map((p) => p.hr))) : 0;
    const maxHr = hrPts.length ? Math.max(...hrPts.map((p) => p.hr)) : 0;
    const avgSpeed = avg(pts.map((p) => p.sp));
    const avgGap = avg(pts.map((p) => p.gap));
    const dist = cumKm;
    const laps = buildLaps(pts, lapsRaw, disc, ftp, avgHr, maxHr);
    return { pts, laps, dplus: Math.round(dplus), dist, avgHr, maxHr, avgSpeed, avgGap, disc, cond: NEUTRAL_COND };
  }

  function buildLaps(pts, lapsRaw, disc, ftp, gAvgHr, gMaxHr) {
    // bornes : laps réels (TCX) sinon découpage régulier (~8 segments)
    let bounds = lapsRaw && lapsRaw.length ? lapsRaw.slice() : null;
    if (!bounds) {
      const n = Math.max(4, Math.min(12, Math.round((pts[pts.length - 1].t) / 10)));
      bounds = [];
      for (let k = 0; k < n; k++) bounds.push({ start: Math.floor((k * pts.length) / n), end: Math.floor(((k + 1) * pts.length) / n) });
    }
    const fcMax = (gMaxHr && gMaxHr > 0) ? Math.max(gMaxHr, 185) : 190;
    return bounds.map((b, i) => {
      const seg = pts.slice(b.start, b.end);
      if (!seg.length) return null;
      const durMin = seg[seg.length - 1].t - seg[0].t;
      const distSeg = (seg[seg.length - 1]._cum - seg[0]._cum);
      const hrSeg = seg.filter((p) => p.hr > 0);
      const avgHr = hrSeg.length ? Math.round(avg(hrSeg.map((p) => p.hr))) : 0;
      const maxHr = hrSeg.length ? Math.max(...hrSeg.map((p) => p.hr)) : 0;
      const pwSeg = seg.filter((p) => p.pw > 0).map((p) => p.pw);
      const avgPower = pwSeg.length ? Math.round(avg(pwSeg)) : 0;
      const np = pwSeg.length ? Math.round(Math.pow(avg(pwSeg.map((w) => Math.pow(w, 4))), 0.25)) : 0;
      // "hard" = série de qualité : forte FC (%FCmax) ou puissance > seuil
      const hard = (avgHr && avgHr / fcMax > 0.85) || (avgPower && avgPower > ftp * 0.95);
      return {
        n: i + 1, dist: distSeg, durMin,
        avgSpeed: avg(seg.map((p) => p.sp)), avgGap: avg(seg.map((p) => p.gap)),
        avgHr, maxHr, avgPower, np, cad: Math.round(avg(seg.map((p) => p.cad || 0))),
        if: (np && ftp) ? +(np / ftp).toFixed(2) : 0,
        kj: avgPower ? Math.round(avgPower * durMin * 60 / 1000) : 0,
        dplus: 0, hard: !!hard,
      };
    }).filter(Boolean);
  }

  /* ---------- utils ---------- */
  function titleFor(disc, data) {
    const km = data.dist >= 1 ? data.dist.toFixed(1) + " km" : "";
    const D = { run: "Course", bike: "Sortie vélo", swim: "Natation", strength: "Renforcement" }[disc] || "Activité";
    return (D + (km ? " · " + km : "")).trim();
  }
  function mapSport(s) {
    s = (s || "").toLowerCase();
    if (/run|cours|jog|trail/.test(s)) return "run";
    if (/bik|cycl|vélo|velo|ride/.test(s)) return "bike";
    if (/swim|nat/.test(s)) return "swim";
    if (/strength|muscu|renfo/.test(s)) return "strength";
    return null;
  }
  function guessDiscFromName(name) {
    return mapSport(name) || "run";
  }
  function haversineKm(la1, lo1, la2, lo2) {
    const R = 6371, dLa = rad(la2 - la1), dLo = rad(lo2 - lo1);
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLo / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function firstTime(raw) { for (const r of raw) if (r.time != null) return r.time; return null; }
  function rad(d) { return d * Math.PI / 180; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : NaN; }
  function local(nn) { return String(nn).replace(/^.*:/, ""); }
  // texte d'un enfant direct/descendant par nom local (ignore le namespace)
  function txt(el, localName) {
    const list = el.getElementsByTagName("*");
    for (let i = 0; i < list.length; i++) if (local(list[i].nodeName) === localName) return list[i].textContent;
    // certains parseurs gardent le nom complet :
    const direct = el.getElementsByTagName(localName)[0];
    return direct ? direct.textContent : null;
  }
  function txt1(el, localName) { return txt(el, localName); }

  root.PFFit = { parse, parseFile };
})(typeof window !== "undefined" ? window : globalThis);
