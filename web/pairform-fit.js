/* ============================================================
   PairForm — Import d'activités .TCX / .GPX  (window.PFFit)
   ------------------------------------------------------------
   Convertit un fichier exporté d'une montre (Garmin, Coros, Polar…)
   en la MÊME structure que genSessionData() de l'app, afin que tout
   le modal d'analyse (vitesse, FC, altitude, puissance, DÉCOUPLAGE,
   ASSISTANT IA) fonctionne sur des données RÉELLES.

   Choix MVP : .TCX et .GPX (XML, zéro dépendance, parse via DOMParser).
   → couvre les exports Garmin Connect / COROS / Strava sans homologation.
   .FIT (binaire) viendra avec une lib dédiée (fit-file-parser).

   API :
     PFFit.parse(text, filename, opts)  -> { ok, error?, summary, data }
     PFFit.parseFile(File, opts)        -> Promise<même chose>
   `data` = { pts, laps, dplus, dist, avgHr, maxHr, avgSpeed, avgGap, disc, cond }
   ============================================================ */
(function (root) {
  "use strict";

  const NEUTRAL_COND = { temp: 15, humidity: 50, wind: 0, windHead: false };

  function parseFile(file, opts) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(parse(String(r.result || ""), file.name || "", opts));
      r.onerror = () => resolve({ ok: false, error: "Lecture du fichier impossible." });
      r.readAsText(file);
    });
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
