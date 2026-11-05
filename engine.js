// 롤투롤 장력 시뮬레이터 — 계산 엔진 v3 (화면과 분리, node 에서도 실행 가능)
// 라인 = 요소 N개 (권출 릴 · 구동 롤 · 아이들 롤 · 권취 릴), 요소 사이 = 스팬, 구동 요소 사이 = 장력 구간.
// 2차: 댄서(②⑤), 구동 롤 미끄럼(감김각·마찰·닙 가압), EPC, 롤 프레스 상·하 2모터 드룹.
// 3차: 구동 롤 여러 개(프리셋: 기본·코터·롤 프레스), 구간별 목표 장력, 중간 롤 역할(드로우 / 장력 루프).
(function (root) {
  'use strict';

  const MATERIALS = {
    cu8:   { name: '동박 Cu 8µm',        E: 110e9, rho: 8960, h: 8e-6,  T0: 40, Tbreak: 300, color: '#c8763a' },
    al15:  { name: '알루미늄박 Al 15µm', E: 70e9,  rho: 2700, h: 15e-6, T0: 60, Tbreak: 500, color: '#aab3bd' },
    sep16: { name: '분리막 PE 16µm',      E: 1.0e9, rho: 950,  h: 16e-6, T0: 12, Tbreak: 250, color: '#dfe7f1' }
  };

  const METHODS = {
    spd:     { no: '①', name: '장력 센서 + 속도 제어' },
    dancer:  { no: '②', name: '댄서 + 속도 제어' },
    trq:     { no: '③', name: '장력 센서 + 토크 제어' },
    nosens:  { no: '④', name: '센서 없는 토크 제어' },
    dancerT: { no: '⑤', name: '댄서 + 속도 + 장력 센서' },
    full:    { no: '⑥', name: '토크 + 센서 + 관성 보상' }
  };
  const isDancer = (m) => m === 'dancer' || m === 'dancerT';

  // 라인 프리셋. k: unw(권출 릴) · drive(구동 롤) · idler(아이들 롤) · wnd(권취 릴)
  //   drive.role: master(라인 속도 기준) · tension(장력 루프) · draw(드로우=속도 비율만)
  //   spans: 요소 사이 거리 m, zf: 구간 목표 장력 = 기준 장력 × zf
  const idlers = (n, name) => Array.from({ length: n }, (_, i) => ({ k: 'idler', name: `${name} ${i + 1}`, R: 0.04, J: 0.002 }));
  const PRESETS = {
    basic: {
      name: '기본: 권출 → 메인 롤 → 권취',
      els: [{ k: 'unw', name: '권출' }, { k: 'drive', name: '메인 롤', role: 'master', type: 'main', R: 0.05 }, { k: 'wnd', name: '권취' }],
      spans: [1.5, 1.5], zf: [1, 1], zones: ['권출 구간', '권취 구간']
    },
    coater: {
      name: '코터: 권출 → 인피드 → 코팅 → 건조로 → 아웃피드 → 권취',
      els: [{ k: 'unw', name: '권출' },
        { k: 'drive', name: '인피드 닙', role: 'tension', type: 'nip', R: 0.05 },
        { k: 'drive', name: '코팅 백업 롤', role: 'master', type: 'backup', R: 0.1 },
        ...idlers(8, '건조로 롤'),
        { k: 'drive', name: '아웃피드 닙', role: 'tension', type: 'nip', R: 0.05 },
        { k: 'wnd', name: '권취' }],
      spans: [1.5, 1.0, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 1.5], zf: [1, 1.25, 1.0, 0.9],
      zones: ['권출 구간', '코팅 구간', '건조 구간', '권취 구간']
    },
    press: {
      name: '롤 프레스: 권출 → 인피드 → 프레스 → 아웃피드 → 권취',
      els: [{ k: 'unw', name: '권출' },
        { k: 'drive', name: '인피드 닙', role: 'tension', type: 'nip', R: 0.05 },
        { k: 'drive', name: '롤 프레스', role: 'master', type: 'press', R: 0.2 },
        { k: 'drive', name: '아웃피드 닙', role: 'tension', type: 'nip', R: 0.05 },
        { k: 'wnd', name: '권취' }],
      spans: [1.5, 1.0, 1.0, 1.5], zf: [1, 1.5, 1.25, 0.9],
      zones: ['권출 구간', '프레스 입구', '프레스 출구', '권취 구간']
    }
  };

  const DEF = {
    span: 1.5, Rc: 0.0381, Jcore: 0.02, b0: 0.02, tc0: 0.3, tauMax: 40, cw: 1500, noise: 0.2, tf: 0.005,
    plcTs: 0.002, dt: 1e-4, wc: 2 * Math.PI * 20, mainTau: 0.02, estopTime: 1.0,
    dLoop: 0.15, dMass: 3, dDamp: 30, dStick: 4, dStroke: 0.06, dReg: 0.15, dancerGains: { kp: 4, ki: 2 },
    webMass: 0.5,
    pR: 0.2, pJ: 3, pTauMax: 100, pTauRated: 50, pRoll: 20, pDroop: 0.05,
    latL: 0.3, epcStroke: 50, epcVmax: 20,
    idB: 0.001, idC: 0.02          // 아이들 롤 베어링 마찰 (점성 N·m·s/rad, 쿨롱 N·m)
  };

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  function recommendGains(method, matKey, width) {
    const m = MATERIALS[matKey];
    const EA = m.E * m.h * width;
    if (method === 'spd') { const G = EA / DEF.span, w = 15; const kp = w / G; return { kp, ki: kp * w / 4 }; }
    if (method === 'dancer') return { ...DEF.dancerGains };
    if (method === 'trq') return { kp: 0.8, ki: 6 };
    if (method === 'dancerT') return { kp: 0.5, ki: 2 };
    if (method === 'full') return { kp: 0.4, ki: 3 };
    return { kp: 0, ki: 0 };
  }

  /** 프리셋 → 요소·스팬·구간 정보 (화면 그림에도 씀) */
  function buildLine(c) {
    const pr = PRESETS[c.preset || 'basic'];
    const els = pr.els.map((e) => ({ ...e }));
    els.forEach((e, i) => {
      if (e.type === 'main') e.type = c.mainType === 'press' ? 'press' : 'nip';
      if (e.k === 'drive' && c.roles && c.roles[i]) e.role = c.roles[i];
    });
    const n = els.length;
    const driven = els.map((e, i) => (e.k === 'idler' ? -1 : i)).filter((i) => i >= 0);
    const mi = els.findIndex((e) => e.role === 'master');
    const zones = [];
    for (let z = 0; z < driven.length - 1; z++) {
      const a = driven[z], b = driven[z + 1];
      const ctrl = b <= mi ? a : b;               // 메인(마스터) 쪽이 아닌 끝 요소가 그 구간을 맡음
      const sensor = ctrl === a ? a : b - 1;      // 장력계는 맡은 요소 바로 옆 스팬
      zones.push({ a, b, ctrl, sensor, up: ctrl === a, name: pr.zones[z], zf: pr.zf[z] });
    }
    const zoneOfSpan = []; zones.forEach((zn, z) => { for (let j = zn.a; j < zn.b; j++) zoneOfSpan[j] = z; });
    return { pr, els, n, spans: pr.spans.slice(), driven, mi, zones, zoneOfSpan };
  }

  function createSim(cfg) {
    const c = Object.assign({
      preset: 'basic', taper: 0, diaAccel: 1, frictionMul: 1, presetErr: 0, diaMethod: 'thick', seed: 12345,
      mainType: 'nip', wrapDeg: 180, mu: 0.2, nip: 100, droop: true, pressMis: 0, elong: 0.003,
      epc: true, epcGain: 0.5, drift: 2, zoneT: null, roles: null, tol: null
    }, cfg);
    const P = DEF;
    const mat = MATERIALS[c.mat];
    const width = c.width, rho = mat.rho;
    const EA = mat.E * mat.h * width;
    const heff = mat.h * c.diaAccel;
    const Rfull = 0.16;
    const g = c.gains || recommendGains(c.method, c.mat, width);
    const dancerOn = isDancer(c.method);
    const line = buildLine(c);
    const { els, n, zones, mi } = line;
    const S = n - 1, Z = zones.length, zl = Z - 1;
    const Ls = line.spans;
    const press = els.some((e) => e.type === 'press');
    const pi = els.findIndex((e) => e.type === 'press');
    const Jof = (R) => P.Jcore + 0.5 * rho * Math.PI * width * (Math.pow(R, 4) - Math.pow(P.Rc, 4));
    const fric = (w, mul) => mul * (P.b0 * w + P.tc0 * Math.tanh(w / 0.05));
    const gDrive = recommendGains('spd', c.mat, width);   // 중간 롤 장력 루프 게인

    let seed = c.seed >>> 0 || 1;
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 1) / 0x7fffffff; };
    const gauss = () => { const u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

    const zT = zones.map((zn, z) => (c.zoneT && c.zoneT[z] > 0 ? c.zoneT[z] : c.T0 * zn.zf));
    const T = zones.length ? [] : [];
    for (let j = 0; j < S; j++) T[j] = zT[line.zoneOfSpan[j]];
    // 요소 상태
    const E = els.map((e, i) => ({
      ...e, i, v: 0, vref: 0, vw: 0, w: 0, stuck: true, Fgrip: 0, margin: 999, slipping: false,
      tol: (c.tol && c.tol[i]) || 0, pid: { i: 0 }, fricMul: 1
    }));

    const s = {
      t: 0, R1: c.D1 / 2, R3: c.D3 / 2, w1: 0, w3: 0, v0: 0, vw: 0, th1: 0, th3: 0,
      T, Tt: T.slice(), Tm: zT.slice(), Tref: zT.slice(), zOff: zT.map(() => 0),
      T1m: zT[0], T2m: zT[zl], Tref1: zT[0], Tref3: zT[zl],
      vcmd: 0, vtgt: 0, acmd: 0, estopping: false, broken: false, fault: null, forceSpeed: false,
      alarms: [], tau1: 0, tau3: 0, mode1: '', mode3: '',
      R1e: (c.D1 / 2) * (1 + c.presetErr), R3e: c.D3 / 2,
      lowCnt: 0, highCnt: 0, tAccEnd: -1e9, wasAcc: false, len: 0,
      slipping: false, slipCount: 0, slipMargin: 999, lastSlipAlarm: -9,
      xd1m: 0, xd3m: 0, xd1: 0, vd1: 0, Fp1: 2 * zT[0], Fc1: 2 * zT[0], xd3: 0, vd3: 0, Fp3: 2 * zT[zl], Fc3: 2 * zT[zl],
      wP: 0, tauU: 0, tauL: 0, refU: 0, refL: 0, tUf: 0, tLf: 0,
      y: 0, ym: 0, u: 0, dLat: 0, latStep: 0, stepT: -1, stepZone: -1, E
    };
    const sv1 = { i: -zT[0] * s.R1 }, sv3 = { i: zT[zl] * s.R3 };
    const svU = { i: 0 }, svL = { i: 0 };
    const pid1 = { i: 0 }, pid3 = { i: 0 }, pidD1 = { i: 0 }, pidD3 = { i: 0 };
    if (c.method === 'trq') { pid1.i = zT[0]; pid3.i = zT[zl]; }
    let cmd1 = { mode: 'trq', tau: -zT[0] * s.R1, wl: 1, wm: -1 }, cmd3 = { mode: 'trq', tau: zT[zl] * s.R3, wl: 1, wm: -1 };
    if (dancerOn) { cmd1 = { mode: 'spd', w: 0 }; cmd3 = { mode: 'spd', w: 0 }; }
    let lastTh1 = 0, lastTh3 = 0, sub = 0;
    const plcEvery = Math.round(P.plcTs / P.dt);
    const log = [];
    let nextLog = 0;
    const vIn = new Float64Array(n), vOut = new Float64Array(n);

    function alarm(msg) { s.alarms.push({ t: s.t, msg }); }
    function trip(msg, toSpeed) {
      if (s.fault) return;
      s.fault = msg; alarm(msg);
      s.vtgt = 0; s.estopping = true;
      if (toSpeed) s.forceSpeed = true;
    }
    function pidStep(p, e, lo, hi, gg) {
      const G = gg || g;
      p.i = clamp(p.i + G.ki * e * P.plcTs, lo, hi);
      return clamp(G.kp * e + p.i, lo, hi);
    }
    // 구간 z 바로 위쪽(들어오는 쪽) 구간 장력 — 드로우 계산용
    const zoneBefore = (i) => zones.findIndex((zn) => zn.b === i);

    // ── PLC 한 주기 (2ms) ─────────────────────────────
    function plc() {
      const Ts = P.plcTs;
      const amax = s.estopping ? c.vset / P.estopTime : c.vset / c.tacc;
      const jerk = amax / (s.estopping ? 0.05 : 0.3 * c.tacc);
      const dv = s.vtgt - s.vcmd;
      let ades = Math.sign(dv) * amax;
      if (Math.sign(s.acmd) === Math.sign(dv) && Math.abs(dv) <= s.acmd * s.acmd / (2 * jerk) + 1e-9) ades = 0;
      s.acmd += clamp(ades - s.acmd, -jerk * Ts, jerk * Ts);
      s.vcmd += s.acmd * Ts;
      if ((s.vtgt - s.vcmd) * dv < 0 || (Math.abs(s.vtgt - s.vcmd) < 1e-4 && Math.abs(s.acmd) < 2 * jerk * Ts)) { s.vcmd = s.vtgt; s.acmd = 0; }
      if (s.vcmd < 0) { s.vcmd = 0; s.acmd = 0; }
      const acc = Math.abs(s.acmd) > 1e-9;
      if (s.wasAcc && !acc) s.tAccEnd = s.t;
      s.wasAcc = acc;
      if (s.vcmd === 0 && s.vtgt === 0) s.estopping = false;

      // 지름 계산
      const d1 = s.th1 - lastTh1, d3 = s.th3 - lastTh3; lastTh1 = s.th1; lastTh3 = s.th3;
      if (c.diaMethod === 'thick') {
        s.R1e -= heff * d1 / (2 * Math.PI);
        s.R3e += heff * d3 / (2 * Math.PI);
      } else if (s.v0 > 0.05) {
        const k = Ts / 0.5;
        if (s.w1 > 0.2) s.R1e += (s.v0 / s.w1 - s.R1e) * k;
        if (s.w3 > 0.2) s.R3e += (s.v0 / s.w3 - s.R3e) * k;
      }
      s.R1e = clamp(s.R1e, P.Rc, 0.2); s.R3e = clamp(s.R3e, P.Rc, 0.2);

      // 구간 목표 장력 (권취 구간 테이퍼)
      for (let z = 0; z < Z; z++) s.Tref[z] = zT[z] + s.zOff[z];
      s.Tref[zl] *= (1 - c.taper * clamp((s.R3e - P.Rc) / (Rfull - P.Rc), 0, 1));
      s.Tref1 = s.Tref[0]; s.Tref3 = s.Tref[zl];

      // 이상 감시 (인터락)
      const running = s.vcmd > 0.05;
      if (!s.fault && running) {
        let lo = 9, hi = 0;
        for (let z = 0; z < Z; z++) { const r = s.Tm[z] / s.Tref[z]; if (r < lo) lo = r; if (r > hi) hi = r; }
        s.lowCnt = lo < 0.3 ? s.lowCnt + Ts : 0;
        if (s.lowCnt > 0.05) trip('장력 저하 (필름 끊김·늘어짐 의심) → 비상 정지, 릴 축 속도 제어로 전환', true);
        s.highCnt = hi > 2.0 ? s.highCnt + Ts : 0;
        if (s.highCnt > 0.05) trip('장력 과다 → 비상 정지', false);
        if (dancerOn && (Math.abs(s.xd1) > 0.95 * P.dStroke || Math.abs(s.xd3) > 0.95 * P.dStroke)) trip('댄서 행정 끝 도달 → 비상 정지', false);
      }
      if (!s.fault && s.R1 < P.Rc + 0.003 && running) trip('권출 롤 소진 → 정지', false);

      // 라인 기준 속도: 롤 프레스가 기준이면 프레스 엔코더 실제 속도(드룹으로 조금 느려짐)를 따라감
      const vl = s.vcmd;   // 상 롤이 라인 속도를 정확히 지키므로 모든 축이 지령 속도를 따름
      s.aline = (vl - (s.vline || 0)) / Ts;
      s.vline = vl;
      // 릴 제어 (권출 = 첫 구간, 권취 = 마지막 구간)
      const e1 = s.Tref1 - s.T1m, e3 = s.Tref3 - s.T2m;
      const m = s.forceSpeed ? 'safe' : c.method;
      s.Fc1 = 2 * s.Tref1; s.Fc3 = 2 * s.Tref3;
      if (m === 'safe') {
        cmd1 = { mode: 'spd', w: vl / s.R1e };
        cmd3 = { mode: 'spd', w: vl / s.R3e };
      } else if (m === 'spd') {
        const lim = 0.1 * c.vset + 0.05;
        const u1 = pidStep(pid1, e1, -lim, lim), u3 = pidStep(pid3, e3, -lim, lim);
        cmd1 = { mode: 'spd', w: (vl - u1) / s.R1e };
        cmd3 = { mode: 'spd', w: (vl + u3) / s.R3e };
      } else if (m === 'dancer' || m === 'dancerT') {
        const lim = 0.1 * c.vset + 0.05, gd = P.dancerGains;
        const u1 = pidStep(pidD1, s.xd1m, -lim, lim, gd);
        const u3 = pidStep(pidD3, s.xd3m, -lim, lim, gd);
        cmd1 = { mode: 'spd', w: (vl - u1) / s.R1e };
        cmd3 = { mode: 'spd', w: (vl + u3) / s.R3e };
        if (m === 'dancerT') {
          const lim2 = 0.3 * c.T0;
          s.Fc1 = 2 * (s.Tref1 + pidStep(pid1, e1, -lim2, lim2));
          s.Fc3 = 2 * (s.Tref3 + pidStep(pid3, e3, -lim2, lim2));
        }
      } else {
        let q1, q3;
        if (m === 'trq') {
          const u1 = pidStep(pid1, e1, 0, 3 * s.Tref1), u3 = pidStep(pid3, e3, 0, 3 * s.Tref3);
          q1 = -s.R1e * u1; q3 = s.R3e * u3;
        } else {
          q1 = -s.Tref1 * s.R1e + fric(s.w1, 1);
          q3 = s.Tref3 * s.R3e + fric(s.w3, 1);
          if (m === 'full') {
            q1 += Jof(s.R1e) * s.acmd / s.R1e;
            q3 += Jof(s.R3e) * s.acmd / s.R3e;
            const lim = 0.5 * c.T0;
            q1 -= s.R1e * pidStep(pid1, e1, -lim, lim);
            q3 += s.R3e * pidStep(pid3, e3, -lim, lim);
          }
        }
        const wl1 = (vl * 1.1 + 0.05) / s.R1e, wl3 = (vl * 1.1 + 0.05) / s.R3e;
        cmd1 = { mode: 'trq', tau: q1, wl: wl1, wm: -0.05 / s.R1e };
        cmd3 = { mode: 'trq', tau: q3, wl: wl3, wm: -0.05 / s.R3e };
      }

      // 구동 롤 속도 지령: 드로우(장력 차이만큼 미리 계산한 속도 비율) + 장력 루프 보정
      const zm = zoneBefore(mi), Tm0 = zm >= 0 ? s.Tref[zm] : s.Tref[0];
      for (const d of E) {
        if (d.k !== 'drive' || d.type === 'press') continue;
        if (d.i === mi) { d.vref = s.vcmd + (E.length > 3 ? s.aline * P.mainTau : 0); continue; }   // 롤 여러 개면 기준 롤도 같은 피드포워드
        const zb = zoneBefore(d.i);
        const Tup = zb >= 0 ? s.Tref[zb] : s.Tref[0];
        let ratio = 1 + (Tup - Tm0) / EA;
        if (press && d.i > pi) ratio *= 1 + c.elong;     // 프레스 지나면 필름이 늘어나 빨라짐
        let v = (vl + s.aline * P.mainTau) * ratio;   // 가속도 피드포워드: 서보 응답 지연만큼 앞서 지령
        if (d.role === 'tension' && !s.forceSpeed) {
          const z = zones.findIndex((zn) => zn.ctrl === d.i);
          const lim = 0.02 * c.vset + 0.02;
          const u = pidStep(d.pid, s.Tref[z] - s.Tm[z], -lim, lim, gDrive);
          v += zones[z].up ? -u : u;      // 위쪽 구간을 맡으면 빠를수록 장력↓, 아래쪽이면 장력↑
        }
        d.vref = v;
      }

      // 롤 프레스: 상·하 롤 속도 지령 (드룹)
      if (press) {
        const wref = (pi === mi ? s.vcmd : E[pi].vref || s.vcmd) / P.pR;
        const D = c.droop ? P.pDroop : 0;
        s.tUf += (s.tauU - s.tUf) * Ts / 0.05;
        s.tLf += (s.tauL - s.tLf) * Ts / 0.05;
        // 미쓰비시 드룹 FB 방식: 상 롤 = 라인 속도 그대로, 하 롤 = 토크 차이만큼 속도 지령을 바꿔 부하 분담
        s.refU = wref;
        s.refL = wref * (1 - D * (s.tLf - s.tUf) / P.pTauRated);
      }

      // EPC
      if (c.epc && !s.broken) {
        const a = Math.max(0, vIn[1]) / P.latL;
        const vcmdEpc = clamp(-c.epcGain * a * s.ym, -P.epcVmax, P.epcVmax);
        s.u = clamp(s.u + vcmdEpc * Ts, -P.epcStroke, P.epcStroke);
      }
    }

    function servo(sv, cmd, w, J) {
      const Kv = P.wc * J, Ki = Kv * P.wc / 4;
      let tau;
      if (cmd.mode === 'spd') {
        const e = cmd.w - w;
        sv.i = clamp(sv.i + Ki * e * P.dt, -P.tauMax, P.tauMax);
        tau = Kv * e + sv.i;
      } else {
        tau = clamp(cmd.tau, Kv * (cmd.wm - w), Kv * (cmd.wl - w));
        sv.i = tau;
      }
      return clamp(tau, -P.tauMax, P.tauMax);
    }
    function pressServo(sv, ref, w, Jeach) {
      const Kv = P.wc * Jeach, Ki = Kv * P.wc / 4, e = ref - w;
      sv.i = clamp(sv.i + Ki * e * P.dt, -P.pTauMax, P.pTauMax);
      return clamp(Kv * e + sv.i, -P.pTauMax, P.pTauMax);
    }
    function breakWeb(msg) {
      if (s.broken) return;
      s.broken = true; for (let j = 0; j < S; j++) { T[j] = 0; s.Tt[j] = 0; } alarm(msg || '필름 끊김');
    }

    function substep() {
      const dt = P.dt;
      if (sub % plcEvery === 0) plc();
      sub++;
      const J1 = Jof(s.R1), J3 = Jof(s.R3);
      s.tau1 = servo(sv1, cmd1, s.w1, J1);
      s.tau3 = servo(sv3, cmd3, s.w3, J3);
      s.mode1 = cmd1.mode; s.mode3 = cmd3.mode;
      const Tt = s.Tt;

      // 구동 롤
      let minMargin = 999, anySlip = false;
      for (const d of E) {
        if (d.k !== 'drive') continue;
        const tin = Tt[d.i - 1], tout = Tt[d.i];
        if (d.type === 'press') {
          const Rl = P.pR * (1 - c.pressMis), ratio = P.pR / Rl;
          const Jt = P.pJ + P.pJ * ratio * ratio;
          s.tauU = pressServo(svU, s.refU, s.wP, Jt / 2);
          s.tauL = pressServo(svL, s.refL, s.wP * ratio, Jt / 2);
          const v = s.wP * P.pR;
          const load = P.pRoll * Math.tanh(v / 0.05) - (tout - tin) * P.pR;
          s.wP += (s.tauU + s.tauL * ratio - load) / Jt * dt;
          d.v = d.vw = s.wP * P.pR; d.stuck = true; d.slipping = false;
          continue;
        }
        d.v += (d.vref * (1 + d.tol) - d.v) * dt / P.mainTau;
        // 미끄럼: 잡는 힘 = 낮은 쪽 장력 × (e^(μθ) − 1) + 2 × μ × 닙 가압
        const wrap = d.type === 'backup' ? 200 : c.wrapDeg, nip = d.type === 'backup' ? 0 : c.nip;
        const cap = Math.exp(c.mu * wrap * Math.PI / 180) - 1;
        const dT = tout - tin;
        d.Fgrip = Math.max(0, Math.min(tin, tout)) * cap + 2 * c.mu * nip;
        d.margin = d.Fgrip - Math.abs(dT);
        if (d.stuck) {
          d.vw = d.v;
          if (!s.broken && d.margin < 0) {
            d.stuck = false; s.slipCount++;
            if (s.t - s.lastSlipAlarm > 2) alarm(`${d.name} 미끄럼 (잡는 힘 부족)`);
            s.lastSlipAlarm = s.t;
          }
        } else {
          const rel = d.vw - d.v;
          const dir = Math.abs(rel) > 1e-6 ? Math.sign(rel) : Math.sign(dT);
          d.vw += (dT - dir * d.Fgrip) / P.webMass * dt;
          const rel2 = d.vw - d.v;
          if ((rel2 * rel <= 0 || Math.abs(rel2) < 1e-5) && d.margin >= 0) { d.stuck = true; d.vw = d.v; }
        }
        d.slipping = !d.stuck;
        if (d.margin < minMargin) minMargin = d.margin;
        if (d.slipping) anySlip = true;
      }
      s.slipMargin = minMargin; s.slipping = anySlip;
      s.v0 = E[mi].v; s.vw = E[mi].vw;

      // 요소별 들어오는/나가는 필름 속도
      for (const e of E) {
        let vi, vo;
        if (e.k === 'unw') vi = vo = s.w1 * s.R1;
        else if (e.k === 'wnd') vi = vo = s.w3 * s.R3;
        else if (e.k === 'idler') vi = vo = e.w * e.R;
        else { vi = e.vw; vo = e.type === 'press' ? e.vw * (1 + c.elong) : e.vw; }
        vIn[e.i] = vi; vOut[e.i] = vo;
      }

      // 댄서 (권출 쪽 = 첫 스팬, 권취 쪽 = 마지막 스팬)
      if (dancerOn && !s.broken) {
        s.Fp1 += (s.Fc1 - s.Fp1) * dt / P.dReg;
        s.Fp3 += (s.Fc3 - s.Fp3) * dt / P.dReg;
        const dyn = (v, Fp, Tt_) => (Fp - 2 * Tt_ - P.dDamp * v - P.dStick * Math.tanh(v / 0.002)) / P.dMass;
        s.vd1 += dyn(s.vd1, s.Fp1, Tt[0]) * dt; s.xd1 += s.vd1 * dt;
        s.vd3 += dyn(s.vd3, s.Fp3, Tt[S - 1]) * dt; s.xd3 += s.vd3 * dt;
        if (Math.abs(s.xd1) > P.dStroke) { s.xd1 = Math.sign(s.xd1) * P.dStroke; s.vd1 = 0; }
        if (Math.abs(s.xd3) > P.dStroke) { s.xd3 = Math.sign(s.xd3) * P.dStroke; s.vd3 = 0; }
      }

      // 스팬 장력
      if (!s.broken) {
        for (let j = 0; j < S; j++) {
          const vd = dancerOn ? (j === 0 ? s.vd1 : j === S - 1 ? s.vd3 : 0) : 0;
          const xd = dancerOn ? (j === 0 ? s.xd1 : j === S - 1 ? s.xd3 : null) : null;
          const Lj = xd === null ? Ls[j] : Ls[j] + 2 * (P.dLoop + xd);
          const gj = vIn[j + 1] - vOut[j] + 2 * vd;
          const Tprev = j > 0 ? T[j - 1] : 0;
          T[j] = Math.max(0, T[j] + (EA * gj + Tprev * vOut[j] - T[j] * vIn[j + 1]) / Lj * dt);
          Tt[j] = T[j] > 0 ? Math.max(0, T[j] + P.cw * gj) : 0;
          if (Tt[j] > mat.Tbreak) breakWeb('장력 과다로 필름 끊김');
        }
      }

      // 릴
      const dR1 = -heff * s.w1 / (2 * Math.PI), dR3 = heff * s.w3 / (2 * Math.PI);
      const dJ1 = 2 * Math.PI * rho * width * Math.pow(s.R1, 3) * dR1;
      const dJ3 = 2 * Math.PI * rho * width * Math.pow(s.R3, 3) * dR3;
      const a1 = (Tt[0] * s.R1 + s.tau1 - fric(s.w1, c.frictionMul) - s.w1 * dJ1) / J1;
      const a3 = (s.tau3 - Tt[S - 1] * s.R3 - fric(s.w3, c.frictionMul) - s.w3 * dJ3) / J3;
      s.w1 += a1 * dt; s.w3 += a3 * dt;
      s.th1 += s.w1 * dt; s.th3 += s.w3 * dt;
      s.R1 = Math.max(P.Rc, s.R1 + dR1 * dt);
      s.R3 = Math.min(0.2, s.R3 + dR3 * dt);
      // 아이들 롤: 앞뒤 장력 차이로 돌고, 베어링 마찰만큼 뒤쪽 장력이 조금 더 높아짐
      for (const e of E) {
        if (e.k !== 'idler') continue;
        const fr = e.fricMul * (P.idB * e.w + P.idC * Math.tanh(e.w / 0.05));
        e.w += ((Tt[e.i] - Tt[e.i - 1]) * e.R - fr) / e.J * dt;
      }
      s.len += s.vw * dt;
      const k = dt / P.tf;
      for (let z = 0; z < Z; z++) s.Tm[z] += (Tt[zones[z].sensor] + P.noise * gauss() - s.Tm[z]) * k;
      s.T1m = s.Tm[0]; s.T2m = s.Tm[zl];

      // 사행 (EPC): 권출 다음 요소의 필름 속도로 따라감
      s.dLat = 0.3 * Math.sin(s.th1) + c.drift * Math.sin(2 * Math.PI * s.t / 20) + s.latStep;
      if (!s.broken) s.y += (Math.max(0, vIn[1]) / P.latL) * (s.u + s.dLat - s.y) * dt;
      s.ym += (s.y + 0.02 * gauss() - s.ym) * k;
      const kd = dt / 0.01;
      s.xd1m += (s.xd1 + 0.00005 * gauss() - s.xd1m) * kd;
      s.xd3m += (s.xd3 + 0.00005 * gauss() - s.xd3m) * kd;

      s.t += dt;
      if (s.t >= nextLog) {
        nextLog += 0.01;
        log.push({
          t: s.t, vcmd: s.vcmd, acc: Math.abs(s.acmd) > 1e-9, settle: s.t - s.tAccEnd < 1.0,
          v0: s.v0, vw: s.vw, v1: s.w1 * s.R1, v3: s.w3 * s.R3,
          T1m: s.T1m, T2m: s.T2m, Tref1: s.Tref1, Tref3: s.Tref3, Tz: s.Tm.slice(), Trz: s.Tref.slice(),
          vd: E.filter((e) => e.k === 'drive').map((e) => e.vw),
          R1: s.R1, R3: s.R3, R1e: s.R1e, R3e: s.R3e, tau1: s.tau1, tau3: s.tau3,
          xd1: s.xd1, xd3: s.xd3, slip: s.slipping, margin: s.slipMargin,
          tauU: s.tauU, tauL: s.tauL, y: s.y, u: s.u,
          fault: !!s.fault, broken: s.broken
        });
      }
    }

    return {
      cfg: c, s, log, mat, P, EA, Jof, dancerOn, press, line,
      advance(t) { const k = Math.round(t / P.dt); for (let i = 0; i < k; i++) substep(); },
      start() { if (!s.fault) { s.vtgt = c.vset; s.estopping = false; } },
      stop() { s.vtgt = 0; },
      estop() { s.vtgt = 0; s.estopping = true; alarm('비상 정지 버튼'); },
      breakWeb() { breakWeb('필름 끊김 (시험)'); },
      latStep(mm) { s.latStep += mm; alarm(`이음매 사행 ${mm > 0 ? '+' : ''}${mm}mm (시험)`); },
      zoneStep(z, frac) {
        z = Math.min(z, Z - 1); const d = zT[z] * frac; s.zOff[z] += d; s.stepT = s.t; s.stepZone = z;
        alarm(`${zones[z].name} 목표 장력 ${d > 0 ? '+' : ''}${d.toFixed(1)}N 변경 (시험)`);
      },
      seizeIdler() {
        const ids = E.filter((e) => e.k === 'idler'); if (!ids.length) return;
        const e = ids[Math.floor(ids.length / 2)]; e.fricMul = 15; alarm(`${e.name} 베어링 고착 (시험)`);
      }
    };
  }

  // ── 시나리오 ──────────────────────────────────────
  // only: 이 프리셋에서만 / multi: 중간 구동 롤이 있는 프리셋에서만
  const SCENARIOS = {
    basic:    { name: '기동 → 정속 → 정지' },
    fast:     { name: '급가속·급감속 (1.5초)' },
    estop:    { name: '정속 중 비상 정지' },
    diaerr:   { name: '권출 지름 입력 10% 틀림' },
    brk:      { name: '정속 중 필름 끊김' },
    friction: { name: '마찰 3배 (릴 베어링 노후)' },
    slip:     { name: '닙 롤 열림·감김 90° (미끄럼)' },
    epc:      { name: '이음매에서 사행 3mm (EPC)' },
    press:    { name: '롤 프레스 하 롤 지름 0.3% 작음', only: ['basic', 'press'] },
    zstep:    { name: '두 번째 구간 목표 장력 +25% (구간 간섭)' },
    wear:     { name: '인피드 롤 지름 0.02% 마모 (드로우 약점)', multi: true },
    seize:    { name: '건조로 아이들 롤 1개 베어링 고착', only: ['coater'] }
  };

  function scenarioPlan(key, cfg) {
    const c = Object.assign({}, cfg);
    if (key === 'fast') c.tacc = 1.5;
    if (key === 'diaerr') c.presetErr = 0.10;
    if (key === 'friction') c.frictionMul = 3;
    if (key === 'slip') { c.nip = 0; c.wrapDeg = 90; }
    if (key === 'press') { c.pressMis = 0.003; if ((c.preset || 'basic') === 'basic') c.mainType = 'press'; }
    if (key === 'wear') { c.tol = Object.assign({}, c.tol, { 1: -0.0002 }); }
    const ta = c.tacc;
    let ev, end;
    if (key === 'estop') { ev = [[0.5, 'start'], [0.5 + ta + 4, 'estop']]; end = 0.5 + ta + 8; }
    else if (key === 'brk') { ev = [[0.5, 'start'], [0.5 + ta + 4, 'break']]; end = 0.5 + ta + 8; }
    else if (key === 'epc') { ev = [[0.5, 'start'], [0.5 + ta + 3, 'lat3'], [0.5 + ta + 12, 'stop']]; end = 0.5 + 2 * ta + 15; }
    else if (key === 'zstep') { ev = [[0.5, 'start'], [0.5 + ta + 3, 'zstep'], [0.5 + ta + 10, 'stop']]; end = 0.5 + 2 * ta + 13; }
    else if (key === 'seize') { ev = [[0.5, 'start'], [0.5 + ta + 3, 'seize'], [0.5 + ta + 10, 'stop']]; end = 0.5 + 2 * ta + 13; }
    else { ev = [[0.5, 'start'], [0.5 + ta + 6, 'stop']]; end = 0.5 + 2 * ta + 9; }
    return { cfg: c, events: ev.map(([t, a]) => ({ t, a })), end };
  }

  /** info: sim.s (stepT, stepZone) — 목표를 바꾼 구간은 바꾼 뒤 3초 동안 평가에서 빼고, 다른 구간 흔들림 = 간섭 */
  function metrics(log, cfg, info) {
    let accMax = 0, stMax = 0, sum = 0, n = 0, epcMax = 0, dMax = 0, imb = 0, slipT = 0, inter = 0;
    const Z = log.length ? log[0].Tz.length : 2;
    const zMax = new Array(Z).fill(0);
    const stepT = info && info.stepT >= 0 ? info.stepT : -1, sz = info ? info.stepZone : -1;
    for (const r of log) {
      if (r.fault || r.broken || r.vcmd < 0.05) continue;
      let d = 0;
      for (let z = 0; z < Z; z++) {
        if (stepT >= 0 && z === sz && r.t >= stepT && r.t < stepT + 3) continue;
        const e = Math.abs(r.Tz[z] - r.Trz[z]);
        if (e > d) d = e; if (e > zMax[z]) zMax[z] = e;
        if (stepT >= 0 && z !== sz && r.t >= stepT && r.t < stepT + 5 && e > inter) inter = e;
      }
      if (r.acc || r.settle) accMax = Math.max(accMax, d);
      else if (r.vcmd > 0.95 * cfg.vset) stMax = Math.max(stMax, d);
      sum += d * d; n++;
      if (r.vcmd > 0.95 * cfg.vset) epcMax = Math.max(epcMax, Math.abs(r.y));
      dMax = Math.max(dMax, Math.abs(r.xd1), Math.abs(r.xd3));
      imb = Math.max(imb, Math.abs(r.tauU - r.tauL));
      if (r.slip) slipT += 0.01;
    }
    const rms = n ? Math.sqrt(sum / n) : 0;
    const worst = Math.max(accMax, stMax) / cfg.T0 * 100;
    const grade = worst <= 5 ? '우수' : worst <= 12 ? '보통' : '나쁨';
    return { accMax, stMax, rms, worstPct: worst, grade, epcMax, dancerMax: dMax * 1000, pressImb: imb, slipT, zMax, inter };
  }

  function act(sim, a) {
    if (a === 'start') sim.start(); else if (a === 'stop') sim.stop(); else if (a === 'estop') sim.estop();
    else if (a === 'break') sim.breakWeb(); else if (a === 'lat3') sim.latStep(3);
    else if (a === 'zstep') sim.zoneStep(1, 0.25); else if (a === 'seize') sim.seizeIdler();
  }
  function runScenario(key, cfg) {
    const plan = scenarioPlan(key, cfg);
    const sim = createSim(plan.cfg);
    let i = 0;
    while (sim.s.t < plan.end) {
      while (i < plan.events.length && plan.events[i].t <= sim.s.t) { act(sim, plan.events[i].a); i++; }
      sim.advance(0.01);
    }
    return { sim, plan, m: metrics(sim.log, plan.cfg, sim.s) };
  }

  const api = { MATERIALS, METHODS, SCENARIOS, PRESETS, DEF, isDancer, recommendGains, buildLine, createSim, scenarioPlan, metrics, runScenario, act };
  if (typeof module !== 'undefined') module.exports = api; else root.R2R = api;
})(this);
