/* 长征跳一跳 —— 主逻辑
 * 玩法核心借鉴 potato47/jump-master：不用物理引擎，
 * 蓄力时间 → 跳跃距离 → 与下一方块落点比较，超过容差即跳空。
 */
(function () {
  "use strict";

  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d");

  /* ---------- 常量 ---------- */
  var GRID = 92;              // 一格在等轴平面上的步长（像素）
  var ISO = 0.55;             // 等轴压扁比例（y 方向）
  var MAX_JUMP = 2.05;        // 满蓄力跳几格
  var TOL = 0.3;              // 落点容差（格），宽容判定：±30% 格内都算踩上
  var PERFECT = 0.08;
  var CHARGE_TIME = 900;      // 满蓄力毫秒
  var MORALE_MAX = 100;       // 士气改为 100 点制，失误只扣 1 点
  var TOTAL_BLOCKS = 24;      // 全程方块数（24 站 → 会宁）

  // 路线站点：index 与问答块对齐（3 的倍数），stage 用于关联题库
  var STOPS = [
    { stage: "瑞金",   label: "瑞金·出发",     sub: "1934.10 · 中央红军出发" },
    { stage: "湘江",   label: "湘江·血战",     sub: "1934.12 · 血战湘江" },
    { stage: "遵义",   label: "遵义·转折",     sub: "1935.01 · 伟大转折" },
    { stage: "赤水",   label: "赤水·四渡",     sub: "1935.02 · 四渡赤水" },
    { stage: "金沙江", label: "金沙江·巧渡",   sub: "1935.05 · 巧渡金沙江" },
    { stage: "泸定桥", label: "大渡河·飞夺",   sub: "1935.05 · 飞夺泸定桥" },
    { stage: "夹金山", label: "夹金山·翻越",   sub: "1935.06 · 翻越雪山" },
    { stage: "草地",   label: "松潘草地·穿越", sub: "1935.08 · 艰难草地" },
    { stage: "会宁",   label: "会宁·会师",     sub: "1936.10 · 三军会师" }
  ];
  // 站点所在方块索引：0 为出发，每 3 格一站与问答块重合，最后为终点
  var STOP_IDX = [0, 3, 6, 9, 12, 15, 18, 21, TOTAL_BLOCKS - 1];

  /* ---------- 状态 ---------- */
  var W, H, dpr;
  var blocks = [];            // {gx,gy,q,isQuiz,stage,stop,milestone}
  var cur = 0;                // 当前所在方块索引
  var player = { x: 0, y: 0, sx: 0, sy: 0, jumpFrom: null, jumpT: 0 };
  var state = "intro";        // intro | ready | charging | jumping | quiz | over
  var chargeStart = 0;
  var morale = MORALE_MAX, score = 0, answered = 0, correct = 0;
  var quizQ = null;
  var quizCorrectBtn = null;   // 当前题的正确项按钮（answer 中高亮用）
  var cam = { x: 0, y: 0 };   // 相机偏移（像素）
  var shakeT = 0;
  var particles = [];
  var flightDur = 380;

  /* ---------- 几何 ---------- */
  // 等轴方向：交替沿 +x（屏幕右上）与 +y（屏幕左上）
  var dirX = { x: 1, y: -ISO }, dirY = { x: -1, y: -ISO };

  function blockScreen(b) {
    return {
      x: b.gx * GRID * dirX.x + b.gy * GRID * dirY.x,
      y: b.gx * GRID * dirX.y + b.gy * GRID * dirY.y
    };
  }

  /* ---------- 初始化 ---------- */
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function buildRoute() {
    blocks = [];
    for (var i = 0; i < TOTAL_BLOCKS; i++) {
      // 交替方向前进，偶尔侧移制造节奏变化
      var gx = 0, gy = 0;
      if (i > 0) {
        var prev = blocks[i - 1];
        if (i % 2 === 1) { gx = prev.gx + 1; gy = prev.gy; }
        else { gx = prev.gx; gy = prev.gy + 1; }
      }
      // 站点方块：终点必是站点；中间站点与问答块（3 的倍数）重合
      var stopIdx = STOP_IDX.indexOf(i);
      var isStop = stopIdx >= 0;
      var isQuiz = isStop && i > 0 && i < TOTAL_BLOCKS - 1;
      blocks.push({
        gx: gx, gy: gy,
        q: null,                   // 题目在 buildRoute 末尾按地点抽取
        isQuiz: isQuiz,
        stage: isStop ? STOPS[stopIdx].stage : null,
        stop: isStop ? stopIdx : -1,
        milestone: isStop ? STOPS[stopIdx].label : null
      });
    }
    // 为每个问答块按当前地点抽取题目
    var used = {};
    blocks.forEach(function (b) {
      if (!b.isQuiz) return;
      b.q = pickQuestion(b.stage, used);
    });
  }

  // 按地点选题：优先该地点未用过的题，否则任意未用过的题，再兜底任意题
  function pickQuestion(stage, used) {
    var all = window.QUESTIONS;
    var pool = all.filter(function (q) { return q.stage === stage && !used[q.q]; });
    if (!pool.length) pool = all.filter(function (q) { return !used[q.q]; });
    if (!pool.length) pool = all;
    var q = pool[Math.floor(Math.random() * pool.length)];
    used[q.q] = true;
    return q;
  }

  function reset() {
    morale = MORALE_MAX; score = 0; answered = 0; correct = 0;
    cur = 0; state = "ready"; particles = [];
    buildRoute();
    var p = blockScreen(blocks[0]);
    player.x = p.x; player.y = p.y;
    player.sx = p.x; player.sy = p.y;
    cam.x = 0; cam.y = 0; updateCam(true); updateHud();
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------- 相机 ---------- */
  function updateCam(snap) {
    // 相机始终把玩家放在屏幕中部偏下
    var ntx = W * 0.5 - player.x;
    var nty = H * 0.62 - player.y;
    if (snap) { cam.x = ntx; cam.y = nty; }
    else { cam.x += (ntx - cam.x) * 0.12; cam.y += (nty - cam.y) * 0.12; }
  }

  /* ---------- 输入 ---------- */
  function pressStart(e) {
    if (e) e.preventDefault();
    if (state === "ready") { state = "charging"; chargeStart = performance.now(); }
  }
  function pressEnd(e) {
    if (e) e.preventDefault();
    if (state !== "charging") return;
    var held = Math.max(0.1, Math.min(performance.now() - chargeStart, CHARGE_TIME) / CHARGE_TIME);
    doJump(held);
  }

  canvas.addEventListener("pointerdown", pressStart);
  window.addEventListener("pointerup", pressEnd);
  window.addEventListener("keydown", function (e) {
    if (e.repeat) return;
    if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") pressStart(e);
  });
  window.addEventListener("keyup", function (e) {
    if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") pressEnd(e);
  });
  document.getElementById("overRestart").addEventListener("click", function () {
    this.blur();
    document.getElementById("overOverlay").hidden = true; reset();
  });

  /* ---------- 跳跃 ---------- */
  function doJump(power) {
    var next = blocks[cur + 1];
    if (!next) return;
    // 预设落点判定：本块到下一块的"格距离"为 1（等轴平面上欧氏距离/GRID）
    var d = power * MAX_JUMP;                    // 本次跳跃的格数
    var dist = 1;                                // 目标落点距离
    player.jumpFrom = { x: player.x, y: player.y };
    player.jumpT = 0;

    var land, success;
    if (Math.abs(d - dist) <= TOL) {
      success = true;
      land = blockScreen(next);
      if (Math.abs(d - dist) <= PERFECT) score += 3; // 正中核心
    } else {
      success = false;
      // 跳到方块外：沿"当前块 → 下一块"的实际方向飞出并下坠
      var fromB = blockScreen(blocks[cur]), toB = blockScreen(next);
      var ang = Math.atan2(toB.y - fromB.y, toB.x - fromB.x);
      var fly = Math.min(d, MAX_JUMP) * GRID;
      land = { x: player.x + Math.cos(ang) * fly, y: player.y + Math.sin(ang) * fly };
    }
    player.jumpTo = land;
    player.success = success;
    player.nextIdx = cur + 1;
    state = "jumping";
  }

  function finishJump() {
    if (player.success) {
      player.x = player.jumpTo.x; player.y = player.jumpTo.y;
      player.sx = player.x; player.sy = player.y;
      cur = player.nextIdx;
      score += 1;
      var b = blocks[cur];
      if (b.q) { state = "quiz"; openQuiz(b); }
      else if (cur === TOTAL_BLOCKS - 1) { endGame(); }
      else state = "ready";
    } else {
      morale--; shakeT = 300;
      updateHud();
      // 长征没有失败：跳空不终结游戏，落回下一格继续赶路
      var next = blocks[player.nextIdx];
      var p = blockScreen(next);
      player.x = p.x; player.y = p.y;
      player.sx = p.x; player.sy = p.y;
      cur = player.nextIdx;
      // 落回的格子如果是问答块，同样要触发问答（之前漏掉导致问答被跳过）
      if (cur === TOTAL_BLOCKS - 1) { endGame(); }
      else if (blocks[cur].q) { state = "quiz"; openQuiz(blocks[cur]); }
      else state = "ready";
    }
    updateCam(false); updateHud();
  }

  /* ---------- 问答 ---------- */
  var quizOverlay = document.getElementById("quizOverlay");
  var quizCard = document.getElementById("quizCard");

  function openQuiz(block) {
    var q = block.q;
    quizQ = q;
    var opts = shuffle(q.opts.map(function (t, i) { return { t: t, i: i }; }));
    var box = document.getElementById("quizOpts");
    box.innerHTML = "";
    quizCorrectBtn = null;
    opts.forEach(function (o) {
      var btn = document.createElement("button");
      btn.className = "quiz-opt";
      btn.textContent = o.t;
      if (o.i === q.a) quizCorrectBtn = btn;   // 记住正确项按钮，避免按文字匹配
      btn.onclick = function () { answer(o.i, btn); };
      box.appendChild(btn);
    });
    // 情境标签：当前站点名 + 年代事件
    var stop = block.stop >= 0 ? STOPS[block.stop] : null;
    document.getElementById("quizTag").textContent =
      "红旗问答 · " + (stop ? stop.sub : "行军途中");
    document.getElementById("quizQ").textContent = q.q;
    document.getElementById("quizExp").textContent =
      "📖 " + q.exp + (q.spirit ? "\n✦ 长征精神：" + q.spirit : "");
    quizCard.classList.remove("revealed");
    quizOverlay.hidden = false;
  }

  function answer(i, btn) {
    if (quizCard.classList.contains("revealed")) return;
    answered++;
    var buttons = document.querySelectorAll(".quiz-opt");
    buttons.forEach(function (b) { b.onclick = null; });
    if (i === quizQ.a) {
      correct++; score += 15;
      btn.classList.add("correct");
      spawnParticles("#b9924f", 24);
    } else {
      btn.classList.add("wrong");
      morale--; shakeT = 250;
      if (quizCorrectBtn) quizCorrectBtn.classList.add("correct");
    }
    quizCard.classList.add("revealed");
    updateHud();
  }

  document.getElementById("quizNext").onclick = function () {
    this.blur();
    quizOverlay.hidden = true;
    if (cur === TOTAL_BLOCKS - 1) { endGame(); return; }
    state = "ready";
  };

  /* ---------- 结算（长征没有失败，只有会师） ---------- */
  function endGame() {
    state = "over";
    document.getElementById("overTitle").textContent = "会宁会师 · 长征胜利！";
    document.getElementById("overSub").textContent = "二万五千里走完，红旗问答也算交上了一份答卷。"
      + (morale < MORALE_MAX ? "这一路摔过跤、答错过，但每一步都算数。" : "");
    document.getElementById("overStats").textContent =
      "士气 " + morale + " ｜ 星火 " + score + " ｜ 问答 " + correct + "/" + answered + " 正确";
    document.getElementById("overOverlay").hidden = false;
  }

  /* ---------- HUD ---------- */
  function updateHud() {
    document.getElementById("morale").textContent = "士气 " + Math.max(morale, 0);
    document.getElementById("score").textContent = "星火 " + score;
    document.getElementById("progressBar").style.width = (cur / (TOTAL_BLOCKS - 1) * 100).toFixed(1) + "%";
  }

  /* ---------- 粒子 ---------- */
  function spawnParticles(color, n) {
    for (var i = 0; i < n; i++) {
      particles.push({
        x: player.x, y: player.y - 30,
        vx: (Math.random() - 0.5) * 5, vy: -Math.random() * 5 - 1,
        life: 1, color: color
      });
    }
  }

  /* ---------- 绘制 ---------- */
  function drawBlock(b, isCur) {
    var p = blockScreen(b);
    var s = GRID * 0.44;                 // 半宽
    var hgt = isCur ? 26 : 20;
    var top = [
      { x: p.x, y: p.y - hgt - s * ISO },
      { x: p.x + s, y: p.y - hgt },
      { x: p.x, y: p.y - hgt + s * ISO },
      { x: p.x - s, y: p.y - hgt }
    ];
    // 侧面
    ctx.fillStyle = "#7a4a2e";
    ctx.beginPath();
    ctx.moveTo(top[3].x, top[3].y); ctx.lineTo(top[2].x, top[2].y);
    ctx.lineTo(top[2].x, top[2].y + hgt + 14); ctx.lineTo(top[3].x, top[3].y + hgt + 14);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#5f3722";
    ctx.beginPath();
    ctx.moveTo(top[1].x, top[1].y); ctx.lineTo(top[2].x, top[2].y);
    ctx.lineTo(top[2].x, top[2].y + hgt + 14); ctx.lineTo(top[1].x, top[1].y + hgt + 14);
    ctx.closePath(); ctx.fill();
    // 顶面
    ctx.fillStyle = b.q ? "#a52525" : (isCur ? "#e9dbc0" : "#fbf5e9");
    ctx.beginPath();
    top.forEach(function (t, i) { i ? ctx.lineTo(t.x, t.y) : ctx.moveTo(t.x, t.y); });
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(91,48,33,.35)"; ctx.lineWidth = 1.2; ctx.stroke();
    // 问答块：五角星
    if (b.q) { drawStar(p.x, p.y - hgt - 16 + s * ISO * 0.5, 9, "#f4e4df"); }
    // 里程碑
    if (b.milestone) {
      ctx.fillStyle = "#6f6057"; ctx.font = "bold 12px " + FONT;
      ctx.textAlign = "center";
      ctx.fillText(b.milestone, p.x, p.y + 34);
    }
  }

  function drawStar(cx, cy, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var rad = (Math.PI / 5) * i - Math.PI / 2;
      var rr = i % 2 === 0 ? r : r * 0.42;
      var x = cx + Math.cos(rad) * rr, y = cy + Math.sin(rad) * rr;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.fill();
  }

  function drawPlayer() {
    var x = player.sx, y = player.sy;
    // 身体：小红军方块
    var w = 26, hh = 30;
    ctx.fillStyle = "#5f7ea6";              // 灰蓝军装
    ctx.fillRect(x - w / 2, y - hh - 8, w, hh);
    ctx.fillStyle = "#8f1d1d";              // 领章
    ctx.fillRect(x - w / 2, y - hh - 8, w, 5);
    ctx.fillStyle = "#e8dcc8";              // 脸
    ctx.fillRect(x - 7, y - hh - 18, 14, 12);
    ctx.fillStyle = "#3c3c3c";              // 八角帽
    ctx.fillRect(x - 9, y - hh - 22, 18, 6);
    drawStar(x, y - hh - 19, 3.4, "#d43a3a");
    // 影子
    ctx.fillStyle = "rgba(60,40,25,.18)";
    ctx.beginPath(); ctx.ellipse(x, y + 4, 14, 6, 0, 0, Math.PI * 2); ctx.fill();
  }

  function drawCharge() {
    if (state !== "charging") return;
    var p = Math.min(performance.now() - chargeStart, CHARGE_TIME) / CHARGE_TIME;
    var x = player.sx, y = player.sy - 56;
    ctx.fillStyle = "rgba(118,22,22,.25)";
    ctx.fillRect(x - 40, y, 80, 8);
    ctx.fillStyle = p > 0.85 ? "#b9924f" : "#8f1d1d";
    ctx.fillRect(x - 40, y, 80 * p, 8);
    // 蓄力下压
    player.squash = 1 + p * 0.28;
  }

  var FONT = getComputedStyle(document.body).fontFamily;   // 缓存字体，避免每帧查询

  var lastT = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    // 帧间隔（首帧或后台切回时钳制，避免大跳变）
    var dt = Math.min(lastT ? now - lastT : 16.7, 100);
    lastT = now;
    // 更新
    if (state === "jumping") {
      player.jumpT += dt;
      var t = Math.min(player.jumpT / flightDur, 1);
      var f = player.jumpFrom, to = player.jumpTo;
      var arc = Math.sin(t * Math.PI) * 90;
      player.sx = f.x + (to.x - f.x) * t;
      player.sy = f.y + (to.y - f.y) * t - arc;
      if (t >= 1) { player.sx = to.x; player.sy = to.y; finishJump(); }
    } else {
      player.sx = player.x; player.sy = player.y;
      player.squash = 1;
    }
    updateCam(false);
    particles.forEach(function (pt) { pt.x += pt.vx; pt.y += pt.vy; pt.vy += 0.3; pt.life -= 0.02; });
    particles = particles.filter(function (pt) { return pt.life > 0; });
    if (shakeT > 0) shakeT -= dt;

    // 绘制
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    var sh = shakeT > 0 ? (Math.random() - 0.5) * 6 * (shakeT / 300) : 0;
    ctx.translate(cam.x + sh, cam.y + sh * 0.5);

    // 远景水印：纪念主题
    ctx.fillStyle = "rgba(143,29,29,.08)";
    ctx.font = "900 40px " + FONT;
    ctx.textAlign = "center";
    ctx.fillText("纪念红军长征胜利九十周年", blockScreen(blocks[0]).x + W * 0.1, blockScreen(blocks[0]).y - 150);

    for (var i = 0; i < blocks.length; i++) {
      drawBlock(blocks[i], i === cur);
    }
    if (state !== "jumping") {
      var sq = player.squash || 1;
      ctx.save();
      ctx.translate(player.sx, player.sy);
      ctx.scale(1 / sq, sq);
      ctx.translate(-player.sx, -player.sy);
      drawPlayer();
      ctx.restore();
    } else drawPlayer();
    drawCharge();

    particles.forEach(function (pt) {
      ctx.globalAlpha = pt.life;
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - 2, pt.y - 2, 4, 4);
    });
    ctx.globalAlpha = 1;
    ctx.restore();

    if (state === "ready") {
      ctx.fillStyle = "rgba(45,33,28,.5)";
      ctx.font = "bold 15px " + FONT;
      ctx.textAlign = "center";
      ctx.fillText("按住蓄力 · 松开起跳", W / 2, H - 40);
    }
  }
  /* ---------- 角落作业信息 ---------- */
  var creditBtn = document.getElementById("creditBtn");
  var creditPanel = document.getElementById("creditPanel");
  var introOverlay = document.getElementById("introOverlay");
  // "i" 按钮只在开场页出现
  creditBtn.style.display = "block";
  creditBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    creditPanel.hidden = !creditPanel.hidden;
  });
  document.addEventListener("click", function (e) {
    if (!creditPanel.hidden && e.target !== creditPanel && e.target !== creditBtn) {
      creditPanel.hidden = true;
    }
  });

  /* ---------- 启动 ---------- */
  document.getElementById("introStart").addEventListener("click", function () {
    this.blur();
    introOverlay.hidden = true;
    creditBtn.style.display = "none";
    creditPanel.hidden = true;
    state = "ready";
  });
  window.addEventListener("resize", resize);
  resize();
  reset();
  state = "intro";            // 首次进入显示开场页，重开时直接开始
  requestAnimationFrame(frame);
})();
