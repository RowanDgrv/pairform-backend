/* Sillance — fond "flux" WebGL partagé.
   Deux régimes qui alternent (cycle 24s) autour d'un corps profilé :
   - EAU  (m=0) : torpille + cône de cavitation, bulles qui grossissent en aval
   - VENT (m=1) : soufflerie / CFD, lignes de courant (écoulement potentiel)
     qui se resserrent au passage du corps + sillage turbulent de von Kármán
   Usage :
     var flow = SillanceFlow.attach(canvas, {
       src:[0.60,0.02],   // position du corps (repère centré, y normalisé)
       dim:[-0.42,0.02],  // centre de la zone atténuée (texte) — null = pas d'atténuation
       onLost:fn          // contexte WebGL perdu (afficher un fallback)
     });
     flow.freeze(t)  // fige à l'instant t (captures) ; eau=18, vent=6, mi=0
   Retourne null si WebGL indisponible. */
(function (global) {
  'use strict';

  var FS = [
    "precision highp float;",
    "uniform vec2 uRes;",
    "uniform float uTime;",
    "uniform vec2 uSrc;",
    "uniform vec3 uDim;", // xy = centre attenue, z = 1 actif / 0 inactif
    "float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }",
    "float vnoise(vec2 p){",
    "  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);",
    "  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);",
    "}",
    "float fbm(vec2 p){",
    "  float v=0.0, a=0.5;",
    "  for(int i=0;i<4;i++){ v += a*vnoise(p); p = p*2.03 + vec2(17.0,9.0); a *= 0.5; }",
    "  return v;",
    "}",
    "void main(){",
    "  vec2 frag = gl_FragCoord.xy / uRes;",
    "  vec2 p = (gl_FragCoord.xy - 0.5*uRes) / uRes.y;",
    "  float cycle = uTime * 6.2831853 / 24.0;",               // eau -> vent -> eau en 24s
    "  float m = smoothstep(0.25, 0.75, 0.5 + 0.5*sin(cycle));", // 0 = eau, 1 = vent
    "  vec2 d = p - uSrc;",
    "  float ax = mix(2.8, 1.7, m);",                           // corps étiré (torpille) -> compact (objet testé)
    "  float R  = mix(0.052, 0.078, m);",
    "  vec2 e = vec2(d.x/ax, d.y);",
    "  float r2 = dot(e,e);",
    "  float R2 = R*R;",
    "  float f = r2/max(R2, 1e-6);",                            // <1 = intérieur du corps
    "  float safe = max(r2, R2*0.55);",
    "  float psi = d.y*(1.0 - R2/safe);",                       // fonction de courant : les lignes contournent le corps
    "  float behind = smoothstep(0.03, -0.12, d.x);",           // aval = à gauche (le corps avance vers la droite)
    "  float spread = mix(0.36, 0.17, m);",                     // cône de cavitation large / sillage aéro serré
    "  float halfw = R + spread*max(-d.x, 0.0);",
    "  float inWake = behind * (1.0 - smoothstep(halfw*0.7, halfw, abs(d.y)));",
    "  float adv = uTime * mix(0.18, 0.6, m);",
    "  float turb = fbm(vec2(d.x*mix(3.2,5.5,m) + adv, d.y*mix(6.0,7.5,m))) - 0.5;",
    "  float turbAmp = inWake * clamp(-d.x*1.6, 0.0, 1.0) * mix(0.12, 0.07, m);",
    "  float flap = sin(d.x*9.0 + uTime*2.6) * exp(-d.y*d.y/(halfw*halfw + 1e-4)) * behind * 0.022 * m;", // von Karman
    "  float yy = psi + turb*turbAmp + flap;",
    "  yy += sin(p.x*2.4 - uTime*0.7) * 0.030 * (1.0-m);",      // houle douce (eau)
    "  yy += (fbm(vec2(p.x*2.2 + uTime*0.05, p.y*3.0)) - 0.5) * 0.018;",
    "  float freq = mix(46.0, 115.0, m);",                      // densité des filets : soufflerie = très dense
    "  float sline = sin(yy*freq);",
    "  float width = mix(0.55, 0.42, m);",
    "  float bright = 1.0 - smoothstep(0.0, width, abs(sline));",
    "  float dash = 0.55 + 0.45*sin(d.x*mix(9.0,16.0,m) + uTime*mix(1.6,4.2,m) + psi*30.0);", // impulsions le long du filet
    "  bright *= mix(0.72 + 0.28*dash, 0.45 + 0.55*dash, m);",
    "  float accel = clamp(R2/safe*2.2, 0.0, 1.0);",            // survitesse au passage du corps (rendu CFD)
    "  vec3 eau  = vec3(0.16, 0.80, 1.00);",
    "  vec3 vent = vec3(1.00, 0.58, 0.22);",
    "  vec3 lineCol = mix(eau, vent, m);",
    "  vec3 hot = mix(lineCol, vec3(1.0, 0.95, 0.85), 0.65);",
    "  vec3 lc = mix(lineCol, hot, accel*mix(0.45, 1.0, m));",  // filets chauffés près du corps
    "  float energy = mix(0.30, 0.58, m) + accel*0.95 + inWake*0.55;",
    "  float bs = mix(38.0, 14.0, clamp(-d.x*1.3, 0.0, 1.0));", // bulles qui grossissent en aval
    "  float bn = vnoise(vec2((d.x + uTime*0.22)*bs, d.y*bs*0.9));",
    "  float bubEnv = inWake * exp(d.x*2.2) * (1.0-m);",        // cavitation dense au cul, s'atténue en aval
    "  float bub = smoothstep(0.70, 0.88, bn) * bubEnv;",
    "  float foam = behind * exp(-d.y*d.y*160.0) * exp(d.x*3.0) * (1.0-m);", // jet de mousse axial
    "  vec3 bg = mix(vec3(0.020,0.038,0.075), vec3(0.043,0.067,0.125), frag.y);",
    "  vec3 col = bg + lc * bright * energy * mix(0.8, 1.0, m);",
    "  col += mix(eau, vec3(0.75,0.95,1.0), 0.4) * (bub*0.75 + foam*0.55);", // cavitation
    "  float bodyMask = smoothstep(1.14, 0.96, f);",
    "  col = mix(col, vec3(0.016, 0.028, 0.052), bodyMask);",   // corps sombre
    "  col += lc * exp(-abs(f-1.0)*6.0) * 0.34;",               // liseré lumineux du corps
    "  vec2 nose = d - vec2(ax*R, 0.0);",
    "  col += lc * exp(-dot(nose,nose)*900.0) * 0.5 * (1.0-m);",// pointe incandescente de la torpille
    "  col += lc * exp(-dot(d,d)*6.0) * 0.10;",
    "  float textDim = smoothstep(0.12, 0.62, length((p - uDim.xy) * vec2(1.0, 1.5)));",
    "  textDim = mix(1.0, textDim, uDim.z);",
    "  col = mix(bg + (col - bg)*0.18, col, textDim);",         // le champ s'efface derrière le texte
    "  float vig = smoothstep(1.45, 0.35, length(p*vec2(0.85,1.1)));",
    "  col *= vig;",
    "  gl_FragColor = vec4(col, 1.0);",
    "}"
  ].join("\n");

  var VS = "attribute vec2 aPos; void main(){ gl_Position = vec4(aPos,0.0,1.0); }";

  function attach(canvas, opts) {
    opts = opts || {};
    var src = opts.src || [0.60, 0.02];
    var dim = opts.dim; // null/undefined = pas d'atténuation
    var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return null;
    var reduceMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var lost = false;
    canvas.addEventListener('webglcontextlost', function (e) {
      e.preventDefault(); lost = true;
      if (opts.onLost) opts.onLost();
    });

    function compile(type, srcCode) {
      var s = gl.createShader(type);
      gl.shaderSource(s, srcCode); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; }
      return s;
    }
    var vs = compile(gl.VERTEX_SHADER, VS);
    var fs = compile(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return null;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(prog)); return null; }
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    var uRes = gl.getUniformLocation(prog, 'uRes');
    var uTime = gl.getUniformLocation(prog, 'uTime');
    var uSrc = gl.getUniformLocation(prog, 'uSrc');
    var uDim = gl.getUniformLocation(prog, 'uDim');

    function resize() {
      var dpr = Math.min(global.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    global.addEventListener('resize', resize);
    resize();

    var start = performance.now();
    var frozen = reduceMotion;
    var freezeT = 18.0; // phase eau si figée
    function draw(t) {
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, t);
      gl.uniform2f(uSrc, src[0], src[1]);
      gl.uniform3f(uDim, dim ? dim[0] : 0.0, dim ? dim[1] : 0.0, dim ? 1.0 : 0.0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    function frame(now) {
      if (lost) return;
      draw(frozen ? freezeT : (now - start) / 1000);
      if (!frozen) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    return {
      freeze: function (t) { frozen = true; freezeT = t; draw(t); },
      resume: function () { if (!lost) { frozen = false; start = performance.now() - freezeT * 1000; requestAnimationFrame(frame); } }
    };
  }

  global.SillanceFlow = { attach: attach };
})(window);
